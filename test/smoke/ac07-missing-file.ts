/**
 * AC7 缺文件 / 恢复（只在 verifier 自己的临时根上做，绝不动用户素材）
 * 判据操作化：
 *   - 临时根 → 放 1 个样本文件 → POST /scan → asset 出现且 status='present'
 *   - 删除磁盘文件 → 重扫 → 同一 asset.id 的 status='missing'（条目与收藏仍在）
 *   - 恢复文件 → 重扫 → status 回 'present'
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { runAc, api, waitJob, assertAc, log, AcPending, ROOT, makeMinimalZip } from "./_lib";

const dir = `${ROOT}/docs/verification/tmp/ac07`;
const file = `${dir}/ac07-sample.zip`;

const findAsset = async (needle: string) => {
  const items = (await api.get("/items?limit=500")).body?.items ?? [];
  for (const it of items) {
    const d = (await api.get(`/items/${it.id}`)).body;
    const a = (d?.assets ?? []).find((x: any) => String(x.path).includes(needle));
    if (a) return { asset: a, item: d.item };
  }
  return null;
};

await runAc("AC7", "文件缺失→missing，恢复→present", { needsServer: true, note: "自建临时根，安全（不触碰用户素材）" }, async () => {
  mkdirSync(dir, { recursive: true });
  // 真实可解析的 ZIP（store）——避免把"坏压缩包"混进本 AC 的语义
  writeFileSync(file, makeMinimalZip([{ name: "smoke-ac07/readme.txt", data: Buffer.from("smoke-ac07 " + Date.now()) }]));

  let rootId = 0;
  const roots = (await api.get("/roots")).body?.roots ?? [];
  const existing = roots.find((r: any) => String(r.path_norm ?? r.path).includes("ac07"));
  if (existing) rootId = existing.id;
  else {
    const r = await api.post("/roots", { path: dir, mode: "index_in_place" });
    assertAc(r.status === 200 || r.status === 201, `POST /roots → ${r.status} ${JSON.stringify(r.body)}`);
    rootId = r.body?.id ?? r.body?.root?.id;
  }
  assertAc(rootId, "拿不到临时根的 rootId");

  const scan = async () => {
    const r = await api.post("/scan", { rootId, deep: true });
    assertAc(r.status === 200 && r.body?.jobId, `POST /scan rootId=${rootId} → ${r.status} ${JSON.stringify(r.body)}`);
    await waitJob(Number(r.body.jobId));
  };

  await scan();
  const got = await findAsset("ac07-sample");
  if (!got) throw new AcPending(`重扫后没有登记到 ${file}（扫描未覆盖该 root 或未实现 loose_file 登记）`);
  assertAc(got.asset.status === "present", `初次扫描后 status=${got.asset.status}（应为 present）`);
  const itemId = got.asset.item_id;

  rmSync(file);
  await scan();
  const gone = await findAsset("ac07-sample");
  assertAc(gone, "文件删除后 asset 记录被物理删除（应保留并标 missing）");
  assertAc(gone!.asset.id === got.asset.id, `asset id 变化：${got.asset.id} → ${gone!.asset.id}`);
  assertAc(gone!.asset.status === "missing", `删除文件后 status=${gone!.asset.status}（应为 missing）`);
  const still = await api.get(`/items/${itemId}`);
  assertAc(still.status === 200, `缺文件后条目消失（item#${itemId} HTTP ${still.status}）`);

  writeFileSync(file, makeMinimalZip([{ name: "smoke-ac07/readme.txt", data: Buffer.from("smoke-ac07 restored " + Date.now()) }]));
  await scan();
  const back = await findAsset("ac07-sample");
  assertAc(back && back.asset.status === "present", `恢复文件后 status=${back?.asset.status}（应为 present）`);
  log(`    asset#${got.asset.id} present → missing → present（item#${itemId} 始终存在）`);
  log(`    清理提示：临时根 id=${rootId} 路径=${dir}；DELETE /roots/${rootId} 需先清空该根的 assets`);
});
