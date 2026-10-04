/**
 * AC10 多头像抽取（【12アバター対応】/21アバター対応/[19 Avatars]/【6Avatars】）
 * 判据操作化：
 *   - 取 compat_declared_count > 0 的条目；declared = ItemCard.compatDeclaredCount，extracted = ItemDetail.avatars.length
 *   - "差值可观测" := 两者都能从 API 读到并打印 diff
 *   - 通过条件：declared >= 3 的条目 extracted 必须 >= 1（否则属漏抽）；且 extracted > declared 时打印告警（超抽）
 *   - 无此类条目 → PENDING（数据集尚未覆盖宣告数场景）
 */
import { runAc, api, log, AcPending, AcFailure } from "./_lib";

await runAc("AC10", "宣告数 vs 实际抽取头像数（item_avatars）", { needsServer: true, note: "需要含【12アバター対応】这类条目的数据" }, async () => {
  const items = (await api.get("/items?limit=500")).body?.items ?? [];
  const declared = items.filter((i: any) => Number(i.compatDeclaredCount ?? 0) > 0);
  if (declared.length === 0) throw new AcPending("没有任何 compat_declared_count>0 的条目；先跑 AC1/AC2 建含宣告数的数据");

  const rows: string[] = [];
  const bad: string[] = [];
  for (const it of declared.slice(0, 100)) {
    const d = (await api.get(`/items/${it.id}`)).body;
    const n = (d?.avatars ?? []).length;
    const dec = Number(it.compatDeclaredCount);
    rows.push(`item#${it.id} declared=${dec} extracted=${n} diff=${dec - n} title=${JSON.stringify(String(it.title).slice(0, 40))}`);
    if (dec >= 3 && n === 0) bad.push(`item#${it.id} declared=${dec} 但抽取 0 个 avatar`);
    if (n > dec) log(`    告警 item#${it.id} 超抽：declared=${dec} extracted=${n}`);
  }
  log("    " + rows.slice(0, 20).join("\n    "));
  if (rows.length > 20) log(`    …其余 ${rows.length - 20} 条同理`);
  if (bad.length) log("    漏抽明细:\n      " + bad.slice(0, 10).join("\n      "));
  if (bad.length) throw new AcFailure(`${bad.length} 个宣告 >=3 的条目抽取为 0（多头像抽取未生效）`);
});
