/**
 * AC3 unitypackage 解析（不启动 Unity）
 * 判据操作化：
 *   - 找到 path 以 MANUKA.unitypackage 结尾的 asset（真实样本 678 条目 / 165 GUID）
 *   - GET /assets/:id/unitypackage 返回的 assets.length（唯一 guid 数）在 165±0（AV_SMOKE_UPKG_GUIDS 可覆盖）
 *   - 打印类型统计；调用前后 pgrep -f Unity 必须为空（"全程不启动 Unity"）
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { runAc, api, assertAc, log, AcPending, waitJob } from "./_lib";

// 只用进程名（comm）匹配，避免 pgrep/ps 自身命令行里含 "Unity" 造成自-match 假阳性
const unityProcs = (): string => {
  try { return execSync("ps -eo comm | grep -x -E 'Unity|Unity Hub|UnityPackageManager' || true", { encoding: "utf8" }).trim(); } catch { return ""; }
};

await runAc("AC3", "unitypackage 列 GUID/路径/类型（不启动 Unity）", { needsServer: true, note: "需要库内存在 MANUKA.unitypackage（真实样本）" }, async () => {
  const expect = Number(process.env.AV_SMOKE_UPKG_GUIDS ?? 165);
  const sampleDir = process.env.AV_SMOKE_UPKG_DIR ?? "%LIBRARY%/MANUKA_ver1.02";
  const sampleFile = `${sampleDir}/MANUKA.unitypackage`;

  const locate = async (): Promise<{ assetId: number; assetPath: string }> => {
    const items = (await api.get("/items?q=MANUKA&limit=100")).body?.items ?? [];
    for (const it of items) {
      const d = (await api.get(`/items/${it.id}`)).body;
      const a = (d?.assets ?? []).find((x: any) => typeof x.path === "string" && x.path.endsWith("MANUKA.unitypackage"));
      if (a) return { assetId: a.id, assetPath: a.path };
    }
    return { assetId: 0, assetPath: "" };
  };
  let { assetId, assetPath } = await locate();
  if (!assetId) {
    // 幂等自举：把样本所在目录登记为库根并扫描（声明副作用：/roots 多一条）
    if (!existsSync(sampleFile)) throw new AcPending(`库内与 ${sampleFile} 都没有 MANUKA.unitypackage；用 AV_SMOKE_UPKG_DIR 指定样本目录`);
    const r = await api.post("/roots", { path: sampleDir, mode: "index_in_place" });
    const rootId = r.body?.id ?? r.body?.root?.id;
    if (r.status !== 200 && r.status !== 201) throw new AcPending(`自举 POST /roots 失败 ${r.status}: ${JSON.stringify(r.body)}`);
    const s = await api.post("/scan", { rootId, deep: true });
    assertAc(s.status === 200 && s.body?.jobId, `自举扫描失败 ${s.status} ${JSON.stringify(s.body)}`);
    await waitJob(Number(s.body.jobId));
    ({ assetId, assetPath } = await locate());
  }
  if (!assetId) throw new AcPending(`扫描后仍未登记 ${sampleFile}（asset 未建立）`);

  const before = unityProcs();
  const r = await api.get(`/assets/${assetId}/unitypackage`, 600_000);
  const after = unityProcs();
  assertAc(r.status === 200, `GET /assets/${assetId}/unitypackage → HTTP ${r.status}: ${JSON.stringify(r.body)?.slice(0, 300)}`);
  const assets = r.body?.assets ?? [];
  const guids = new Set(assets.map((a: any) => a.guid));
  assertAc(guids.size === expect, `唯一 GUID 数 ${guids.size} != 期望 ${expect}（样本：678 条目 / 165 GUID）`);
  const byType = new Map<string, number>();
  for (const a of assets) byType.set(a.type ?? "(null)", (byType.get(a.type ?? "(null)") ?? 0) + 1);
  assertAc(!before && !after, `调用前后出现 Unity 进程 → 违反"不启动 Unity"：before=${before} after=${after}`);
  log(`    asset#${assetId} ${assetPath}`);
  log(`    GUID 数=${guids.size} 条数=${assets.length} 用时=${r.ms.toFixed(0)}ms 类型统计=${JSON.stringify([...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
  log(`    样例路径: ${assets.slice(0, 3).map((a: any) => a.assetPath).join(" | ")}`);
});
