/**
 * AC1 扫库建档 + 自动匹配 0 错配
 * 判据操作化（写清度量定义，避免退化）：
 *   - 触发一次深度扫描后，存在 source_site='booth' 且 source_item_id 非空的自动匹配条目（否则 PENDING：没数据可判）
 *   - "错配" := 自动匹配条目的 source_item_id 没有出现在 canonical_url/source_url 里，或 id_confidence < 0.6
 *   - "置信度不足进 inbox" := id_confidence < 0.8 的条目 status 必须是 'inbox'
 *   - 任一条违反 → 该条计入错配；错配数必须为 0
 */
import { existsSync } from "node:fs";
import { runAc, api, waitJob, assertAc, log, AcPending } from "./_lib";

await runAc("AC1", "扫库建档 + 自动匹配 0 错配", { needsServer: true, note: "对真实素材目录执行深度扫描（可能 >1min，建议后台跑）" }, async () => {
  const libPath = process.env.AV_SMOKE_LIB ?? "%LIBRARY%/素材库";
  if (!existsSync(libPath)) throw new AcPending(`素材目录不存在：${libPath}（用 AV_SMOKE_LIB 覆盖）`);
  const r = await api.post("/scan", { path: libPath, deep: true });
  assertAc(r.status === 200, `POST /scan → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const jobId = r.body?.jobId ?? r.body?.id;
  assertAc(jobId, `POST /scan 未返回 jobId: ${JSON.stringify(r.body)}`);
  log(`    scan jobId=${jobId} root=${libPath}`);
  await waitJob(Number(jobId));

  const list = (await api.get("/items?limit=500")).body?.items ?? [];
  assertAc(Array.isArray(list), "GET /items 返回不是 {items:[]}");
  const candidates = list.filter((i: any) => i.sourceSite === "booth" && i.sourceItemId);
  if (candidates.length === 0) throw new AcPending(`扫描完成但没有 booth 自动匹配条目（items=${list.length}）；确认素材目录内容或扩大扫描范围`);

  const bad: string[] = [];
  let autoChecked = 0, inboxOk = 0;
  for (const c of candidates.slice(0, 50)) {
    const d = (await api.get(`/items/${c.id}`)).body;
    if (!d?.item) continue;
    autoChecked++;
    const it = d.item;
    const sid = String(it.source_item_id);
    const urls = `${it.canonical_url ?? ""} ${it.source_url ?? ""}`;
    if (!urls.includes(sid)) bad.push(`item#${c.id} sid=${sid} 不在 url: ${urls.trim()}`);
    if (it.id_confidence != null && it.id_confidence < 0.6) bad.push(`item#${c.id} id_confidence=${it.id_confidence} < 0.6`);
    if (it.id_confidence != null && it.id_confidence < 0.8) {
      if (it.status === "inbox") inboxOk++; else bad.push(`item#${c.id} 低置信(${it.id_confidence}) 却 status=${it.status}（应为 inbox）`);
    }
  }
  log(`    自动匹配候选=${candidates.length} 抽检=${autoChecked} 低置信进 inbox=${inboxOk} 错配=${bad.length}`);
  if (bad.length) log("    错配明细:\n      " + bad.slice(0, 20).join("\n      "));
  assertAc(bad.length === 0, `自动匹配错配 ${bad.length} 条（明细见上）`);
});
