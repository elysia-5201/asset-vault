/**
 * AC12 别名归一 + 冲突 409
 * 判据操作化：
 *   - マヌカ / まぬか / Manuka / MANUKA 四个查询都命中同一个 avatar.id
 *   - 把已属于 avatar1 的别名加到 avatar2 → 必须 409 CONFLICT（进待确认，不静默合并）
 * 副作用声明：v1 API 没有 DELETE /avatars/:id，本脚本若需新建 avatar 会留下 SMOKE-AC12-* 记录（已打印 id）。
 */
import { runAc, api, assertAc, log, AcPending } from "./_lib";

const VARIANTS = ["マヌカ", "まぬか", "Manuka", "MANUKA"];

const findAvatarByQuery = async (q: string): Promise<any> => {
  const r = await api.get(`/avatars?q=${encodeURIComponent(q)}`);
  const list = r.body?.avatars ?? [];
  return list[0] ?? null;
};

await runAc("AC12", "别名归一（マヌカ/まぬか/Manuka/MANUKA）+ 冲突 409", { needsServer: true }, async () => {
  let target = await findAvatarByQuery("まぬか");
  if (!target) {
    const created = await api.post("/avatars", { name: "SMOKE-AC12-Manuka", aliases: VARIANTS, kind: "avatar" });
    if (created.status === 409) throw new AcPending("别名已被别的 avatar 占用（409）；请人工确认 AC12 预置数据");
    assertAc(created.status === 200 || created.status === 201, `POST /avatars → ${created.status} ${JSON.stringify(created.body)}`);
    target = created.body?.avatar ?? created.body;
  }
  assertAc(target?.id, "拿不到 avatar id");
  log(`    target avatar=#${target.id} ${target.name}（副作用：v1 无 DELETE /avatars）`);
  const ids: Record<string, number | null> = {};
  for (const v of VARIANTS) {
    const a = await findAvatarByQuery(v);
    ids[v] = a?.id ?? null;
    assertAc(a?.id === target.id, `q=${v} 命中 avatar#${a?.id ?? "null"}，期望同一 #${target.id}（别名未归一）`);
  }
  log("    归一结果: " + JSON.stringify(ids));

  const other = await api.post("/avatars", { name: "SMOKE-AC12-Other-" + Date.now() });
  assertAc(other.status === 200 || other.status === 201, `建对手 avatar 失败 ${other.status}`);
  const oid = other.body?.avatar?.id ?? other.body?.id;
  const conflict = await api.post(`/avatars/${oid}/aliases`, { alias: "まぬか" });
  assertAc(conflict.status === 409, `冲突别名应 409，实际 ${conflict.status} ${JSON.stringify(conflict.body)}（存在静默合并风险）`);
  assertAc(String(conflict.body?.error?.code ?? "") === "CONFLICT", `409 但 code=${JSON.stringify(conflict.body?.error)}`);
  log(`    avatar#${oid} 添加已占别名 まぬか → 409 CONFLICT ✓`);
});
