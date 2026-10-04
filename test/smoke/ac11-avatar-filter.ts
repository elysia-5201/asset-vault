/**
 * AC11 按 avatar 快筛
 * 判据操作化：
 *   - 取 itemCount>0 的 avatar A（以及有数据的 B ≠ A）
 *   - GET /items?avatar=A → 每条结果的 avatars 里必须含 A
 *   - GET /items?avatar=A&avatar=A&avatarMatch=all → total <= any 的 total，且每条同时含 A、B
 *   - GET /items?avatar=A&avatar=B&avatarMatch=any → 每条至少含 A 或 B
 *   - 无可用数据 → PENDING
 */
import { runAc, api, assertAc, log, AcPending } from "./_lib";

await runAc("AC11", "avatar 快筛 any/all", { needsServer: true }, async () => {
  const avatars = (await api.get("/avatars?ownedOnly=0")).body?.avatars ?? (await api.get("/avatars")).body?.avatars ?? [];
  const withItems = avatars.filter((a: any) => Number(a.itemCount ?? 0) > 0).sort((a: any, b: any) => Number(b.itemCount) - Number(a.itemCount));
  if (withItems.length === 0) throw new AcPending("没有任何 itemCount>0 的 avatar；先跑 AC1/AC2/AC10 建关联数据");
  const A = withItems[0];
  const B = withItems[1] ?? A;

  const one = await api.get(`/items?avatar=${A.id}&limit=200`);
  const oneItems = one.body?.items ?? [];
  assertAc(oneItems.length > 0, `avatar=${A.id}(${A.name}) 返回 0 条但 itemCount=${A.itemCount}`);
  const missA = oneItems.filter((i: any) => !(i.avatars ?? []).some((x: any) => x.id === A.id));
  assertAc(missA.length === 0, `${missA.length} 条结果的 avatars 不含 A（快筛串味）`);
  log(`    A=#${A.id} ${A.name} itemCount=${A.itemCount} 返回=${oneItems.length} 不含A=${missA.length}`);

  if (B.id !== A.id) {
    const all = await api.get(`/items?avatar=${A.id}&avatar=${B.id}&avatarMatch=all&limit=200`);
    const any = await api.get(`/items?avatar=${A.id}&avatar=${B.id}&avatarMatch=any&limit=200`);
    const allItems = all.body?.items ?? [], anyItems = any.body?.items ?? [];
    const badAll = allItems.filter((i: any) => !((i.avatars ?? []).some((x: any) => x.id === A.id) && (i.avatars ?? []).some((x: any) => x.id === B.id)));
    assertAc(badAll.length === 0, `avatarMatch=all 有 ${badAll.length} 条并非同时含 A、B`);
    assertAc(allItems.length <= anyItems.length, `all(${allItems.length}) > any(${anyItems.length})，集合语义相反`);
    const badAny = anyItems.filter((i: any) => !((i.avatars ?? []).some((x: any) => x.id === A.id) || (i.avatars ?? []).some((x: any) => x.id === B.id)));
    assertAc(badAny.length === 0, `avatarMatch=any 有 ${badAny.length} 条既不含 A 也不含 B`);
    log(`    B=#${B.id} ${B.name}: all=${allItems.length} any=${anyItems.length}（all<=any 成立）`);
  } else {
    log("    只有一个 avatar 有数据 → 跳过 all/any 对照（用 itemCount>0 的第二个 avatar 可启用）");
  }
});
