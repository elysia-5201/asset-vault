/**
 * Task 3：版本关系持久化 + 导入预检/commit 路由（import-precheck spec §5.1/§6.2/§9.2/§10）。
 * 只连临时 DB 与临时文件；不 listen、不碰 7317/data/真实素材。
 *
 * 覆盖：
 *  - brief 原例：规范 a<b、逆关系对调、CAS 转移、同状态 no-op、version_link.confirm=1。
 *  - Ruling15：relation-only 更正（version+1、保留 decidedAt/basis/evidence、审计 correct）；
 *    stale expectedVersion 即使同 state 也 409；state/relation 均无变化才 no-op。
 *  - 状态转移表：confirmed→candidate、revoked→confirmed、revoked→candidate；同时更正+转移只一次递增/一次审计。
 *  - 重复对 409、跨 item 400、不存在 404；DELETE 任意状态、审计与删除同事务（审计失败回滚）、id 不复用。
 *  - list：updated_at DESC,id DESC、state 筛选、total 匹配、默认 50/上限 200、trashed item 仍可列、assets DTO。
 *  - 路由：新端点注册与委托、错误 details 保留、旧 POST /api/import/download 未注册。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openTempDb, addRoot, addItem, addAsset, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { createVersionLink, patchVersionLink, listVersionLinks, deleteVersionLink } from "../../apps/server/src/db/version-links";
import { registerImportPrecheckRoutes } from "../../apps/server/src/http/routes/import-precheck";
import { createStageTokenCodec } from "../../apps/server/src/services/stage-token";
import { sha256Text } from "../../apps/server/src/util";

test("建关系规范化 a<b；CAS 转移；同状态 no-op", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const link = createVersionLink(repo, itemId, { assetAId: a2, assetBId: a1, relation: "a_newer" });
  assert.equal(link.assetAId, a1); assert.equal(link.assetBId, a2); assert.equal(link.relation, "b_newer");
  assert.equal(link.state, "candidate"); assert.equal(link.version, 1);
  const confirmed = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 1 });
  assert.equal(confirmed.state, "confirmed"); assert.equal(confirmed.version, 2); assert.ok(confirmed.decidedAt);
  const noop = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 2 });
  assert.equal(noop.version, 2);
  assert.throws(() => patchVersionLink(repo, itemId, link.id, { state: "revoked", expectedVersion: 1 }), (e: any) => e.code === "CONFLICT");
  assert.equal(listVersionLinks(repo, itemId, {}).total, 1);
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.confirm"), 1);
  t.close();
});

test("relation-only 更正：CAS 后 version+1、保留 decidedAt/basis/evidence、审计 correct；stale 同状态仍 409", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const link = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "same", basis: "filename", evidence: { k: 1 } });
  assert.equal(link.basis, "filename");
  assert.deepEqual(link.evidence, { k: 1 });
  const confirmed = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 1 });
  const decidedAt = confirmed.decidedAt;
  assert.ok(decidedAt);
  const corrected = patchVersionLink(repo, itemId, link.id, { relation: "a_newer", expectedVersion: 2 });
  assert.equal(corrected.relation, "a_newer");
  assert.equal(corrected.state, "confirmed");
  assert.equal(corrected.version, 3);
  assert.equal(corrected.decidedAt, decidedAt, "relation-only 更正保留 decided_at");
  assert.equal(corrected.basis, "filename");
  assert.deepEqual(corrected.evidence, { k: 1 });
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.correct"), 1);
  // stale expectedVersion 即使请求同 state 也 409（CAS 在 no-op 之前）
  assert.throws(() => patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 2 }), (e: any) => e.code === "CONFLICT");
  assert.equal(listVersionLinks(repo, itemId, {}).links[0].version, 3);
  // 无实质变化才 no-op：不递增、不审计
  const noop = patchVersionLink(repo, itemId, link.id, { state: "confirmed", relation: "a_newer", expectedVersion: 3 });
  assert.equal(noop.version, 3);
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.correct"), 1);
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.confirm"), 1);
  t.close();
});

test("状态转移表：confirmed→candidate、revoked→confirmed、revoked→candidate 均 version+1 且审计；同时更正+转移只一次递增", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const link = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "same" });
  const c = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 1 });
  assert.equal(c.version, 2);
  const back = patchVersionLink(repo, itemId, link.id, { state: "candidate", expectedVersion: 2 });
  assert.equal(back.version, 3); assert.equal(back.state, "candidate");
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.reopen"), 1);
  const rev = patchVersionLink(repo, itemId, link.id, { state: "revoked", expectedVersion: 3 });
  assert.equal(rev.version, 4); assert.equal(rev.state, "revoked");
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.revoke"), 1);
  const re = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 4 });
  assert.equal(re.version, 5); assert.equal(re.state, "confirmed"); assert.ok(re.decidedAt);
  const re2 = patchVersionLink(repo, itemId, link.id, { state: "revoked", expectedVersion: 5 });
  assert.equal(re2.version, 6);
  const re3 = patchVersionLink(repo, itemId, link.id, { state: "candidate", expectedVersion: 6 });
  assert.equal(re3.version, 7);
  const beforeAudits = count(t.db, "audit_log", "entity=?", "asset_version_link");
  const combo = patchVersionLink(repo, itemId, link.id, { relation: "companion", state: "confirmed", expectedVersion: 7 });
  assert.equal(combo.version, 8);
  assert.equal(combo.relation, "companion");
  assert.equal(combo.state, "confirmed");
  assert.equal(count(t.db, "audit_log", "entity=?", "asset_version_link"), beforeAudits + 1, "同时更正+转移只写一次审计");
  t.close();
});

test("重复对 409；跨 item 400；不存在 404；DELETE 任意状态、审计同事务、id 不复用", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" }); const other = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const b1 = addAsset(t.db, other, rootId, "/lib/b1.zip");
  const link = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "same" });
  assert.throws(() => createVersionLink(repo, itemId, { assetAId: a2, assetBId: a1, relation: "same" }), (e: any) => e.code === "CONFLICT" && e.status === 409);
  assert.throws(() => createVersionLink(repo, itemId, { assetAId: a1, assetBId: b1, relation: "same" }), (e: any) => e.code === "INVALID_INPUT" && e.status === 400);
  assert.throws(() => createVersionLink(repo, itemId, { assetAId: a1, assetBId: 999999, relation: "same" }), (e: any) => e.code === "NOT_FOUND");
  assert.throws(() => createVersionLink(repo, itemId, { assetAId: a1, assetBId: a1, relation: "same" }), (e: any) => e.code === "INVALID_INPUT");
  assert.throws(() => createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "nope" as any }), (e: any) => e.code === "INVALID_INPUT");
  // 已确认也可删；审计与删除同事务：审计失败 → 删除回滚
  patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 1 });
  t.db.exec("CREATE TRIGGER t3_fail_delete_audit BEFORE INSERT ON audit_log WHEN NEW.action='version_link.delete' BEGIN SELECT RAISE(ABORT,'boom'); END");
  assert.throws(() => deleteVersionLink(repo, itemId, link.id));
  assert.equal(count(t.db, "asset_version_links"), 1, "审计失败 → 删除回滚");
  t.db.exec("DROP TRIGGER t3_fail_delete_audit");
  assert.deepEqual(deleteVersionLink(repo, itemId, link.id), { deleted: true });
  assert.equal(count(t.db, "asset_version_links"), 0);
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.delete"), 1);
  assert.throws(() => deleteVersionLink(repo, itemId, link.id), (e: any) => e.code === "NOT_FOUND");
  const link2 = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "same" });
  assert.ok(link2.id > link.id, "AUTOINCREMENT 不复用已删除 id");
  t.close();
});

test("list：updated_at DESC,id DESC；state 筛选；total 匹配；trashed item 仍可列；assets DTO", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip"); const a3 = addAsset(t.db, itemId, rootId, "/lib/3.zip");
  const l1 = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a2, relation: "same" });
  const l2 = createVersionLink(repo, itemId, { assetAId: a1, assetBId: a3, relation: "same" });
  const l3 = createVersionLink(repo, itemId, { assetAId: a2, assetBId: a3, relation: "same" });
  t.db.prepare("UPDATE asset_version_links SET updated_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", l1.id);
  t.db.prepare("UPDATE asset_version_links SET updated_at=? WHERE id=?").run("2026-01-02T00:00:00.000Z", l2.id);
  t.db.prepare("UPDATE asset_version_links SET updated_at=? WHERE id=?").run("2026-01-02T00:00:00.000Z", l3.id);
  const all = listVersionLinks(repo, itemId, {});
  assert.equal(all.total, 3);
  assert.deepEqual(all.links.map((l) => l.id), [l3.id, l2.id, l1.id], "updated_at DESC, id DESC");
  const row = all.links[0];
  assert.equal(typeof row.assets.a.id, "number");
  assert.equal(typeof row.assets.a.path, "string");
  assert.equal(typeof row.assets.a.size, "number");
  assert.ok("mtime" in row.assets.a);
  assert.equal(row.assets.a.id, row.assetAId);
  assert.equal(row.assets.b.id, row.assetBId);
  patchVersionLink(repo, itemId, l1.id, { state: "confirmed", expectedVersion: 1 });
  const conf = listVersionLinks(repo, itemId, { state: "confirmed" });
  assert.equal(conf.total, 1); assert.equal(conf.links[0].id, l1.id);
  assert.equal(listVersionLinks(repo, itemId, { limit: 1 }).links.length, 1);
  assert.equal(listVersionLinks(repo, itemId, { limit: 1 }).total, 3);
  assert.throws(() => listVersionLinks(repo, itemId, { state: "nope" as any }), (e: any) => e.code === "INVALID_INPUT");
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(itemId);
  assert.equal(listVersionLinks(repo, itemId, {}).total, 3, "trashed item 的关系仍可列（不悄加 active 过滤）");
  t.close();
});

test("list：默认 50、上限 200", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const ids: number[] = [];
  for (let i = 0; i < 205; i++) ids.push(addAsset(t.db, itemId, rootId, "/lib/x" + i + ".zip"));
  const ins = t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 204; i++) ins.run(itemId, ids[i], ids[i + 1], "same", "manual", "candidate", 1, NOW, NOW);
  assert.equal(listVersionLinks(repo, itemId, {}).links.length, 50);
  assert.equal(listVersionLinks(repo, itemId, {}).total, 204);
  assert.equal(listVersionLinks(repo, itemId, { limit: 999 }).links.length, 200);
  t.close();
});

test("路由：precheck/version-links/commit 注册与委托；错误 details 保留；旧 /api/import/download 未注册", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" }); const other = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const b1 = addAsset(t.db, other, rootId, "/lib/b1.zip");
  const dir = mkdtempSync(join(tmpdir(), "av-vl-route-"));
  const file = join(dir, "a.zip"); writeFileSync(file, "AAA"); const st = statSync(file);
  const codec = createStageTokenCodec(Buffer.from("k1"), "ep1");
  const app = Fastify({ logger: false });
  registerImportPrecheckRoutes(app as any, {
    repo, codec, media: {} as any, booth: { fetchItem: async () => ({}) } as any, log: () => {}, attach: async () => {},
  });
  await app.ready();
  try {
    let res = await app.inject({ method: "POST", url: "/api/import/precheck", payload: { paths: ["relative/x.zip"] } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "INVALID_INPUT");
    res = await app.inject({ method: "POST", url: "/api/import/precheck", payload: { paths: [] } });
    assert.equal(res.statusCode, 400);

    res = await app.inject({ method: "POST", url: "/api/items/" + itemId + "/version-links", payload: { assetAId: a2, assetBId: a1, relation: "a_newer" } });
    assert.equal(res.statusCode, 200);
    const created = JSON.parse(res.body);
    assert.equal(created.assetAId, a1); assert.equal(created.assetBId, a2); assert.equal(created.relation, "b_newer");
    res = await app.inject({ method: "POST", url: "/api/items/" + itemId + "/version-links", payload: { assetAId: a1, assetBId: b1, relation: "same" } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "INVALID_INPUT");

    res = await app.inject({ method: "GET", url: "/api/items/" + itemId + "/version-links?state=candidate" });
    assert.equal(res.statusCode, 200);
    const listed = JSON.parse(res.body);
    assert.equal(listed.itemId, itemId); assert.equal(listed.total, 1);
    res = await app.inject({ method: "GET", url: "/api/items/" + itemId + "/version-links?state=nope" });
    assert.equal(res.statusCode, 400);

    res = await app.inject({ method: "PATCH", url: "/api/items/" + itemId + "/version-links/" + created.id, payload: { state: "confirmed", expectedVersion: 9 } });
    assert.equal(res.statusCode, 409);
    res = await app.inject({ method: "PATCH", url: "/api/items/" + itemId + "/version-links/" + created.id, payload: { state: "confirmed" } });
    assert.equal(res.statusCode, 400);
    res = await app.inject({ method: "PATCH", url: "/api/items/" + itemId + "/version-links/" + created.id, payload: { state: "confirmed", expectedVersion: 1 } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).version, 2);

    res = await app.inject({ method: "DELETE", url: "/api/items/" + itemId + "/version-links/" + created.id });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { deleted: true });
    res = await app.inject({ method: "DELETE", url: "/api/items/" + itemId + "/version-links/" + created.id });
    assert.equal(res.statusCode, 404);

    // commit：HTTP 契约字段是 stageToken（spec §6.4:373）；仅旧错 key `token` → 400 stageToken 必填，且不消费 nonce/不建 item/asset
    const token = codec.issue({ p: file, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: Date.now() + 60_000, n: "route-n1" });
    const receiptsBefore = count(t.db, "import_stage_commits");
    const itemsBefore = count(t.db, "items");
    const assetsBefore = count(t.db, "assets");
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { token, decision: "skip" } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "INVALID_INPUT");
    assert.match(JSON.parse(res.body).error.message, /stageToken 必填/);
    assert.equal(count(t.db, "import_stage_commits"), receiptsBefore, "旧错 key 不消费 nonce");
    assert.equal(count(t.db, "items"), itemsBefore, "旧错 key 不建 item");
    assert.equal(count(t.db, "assets"), assetsBefore, "旧错 key 不建 asset");

    // 非法 stageToken → 410 且 details.code 保留；非法 decision → 400
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: "not-a-token", decision: "import" } });
    assert.equal(res.statusCode, 410);
    assert.equal(JSON.parse(res.body).error.details.code, "STAGE_TOKEN_INVALID");
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: "x", decision: "nope" } });
    assert.equal(res.statusCode, 400);
    // 合法 stageToken（skip）→ 200；重复提交幂等 200 replayed
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: token, decision: "skip" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { replayed: false, decision: "skip", skipped: true });
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: token, decision: "skip" } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).replayed, true);

    // 合法 stageToken（import）→ 200 指针；重复提交幂等，不新增 item/asset/回执
    const importToken = codec.issue({ p: file, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: Date.now() + 60_000, n: "route-n2" });
    const itemsBeforeImport = count(t.db, "items");
    const assetsBeforeImport = count(t.db, "assets");
    const receiptsBeforeImport = count(t.db, "import_stage_commits");
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: importToken, decision: "import" } });
    assert.equal(res.statusCode, 200);
    const imported = JSON.parse(res.body);
    assert.equal(imported.replayed, false);
    assert.equal(imported.decision, "import");
    assert.equal(typeof imported.itemId, "number");
    assert.equal(typeof imported.assetId, "number");
    assert.equal(count(t.db, "items"), itemsBeforeImport + 1);
    assert.equal(count(t.db, "assets"), assetsBeforeImport + 1);
    assert.equal(count(t.db, "import_stage_commits"), receiptsBeforeImport + 1);
    res = await app.inject({ method: "POST", url: "/api/import/download/commit", payload: { stageToken: importToken, decision: "import" } });
    assert.equal(res.statusCode, 200);
    const replayedImport = JSON.parse(res.body);
    assert.equal(replayedImport.replayed, true);
    assert.equal(replayedImport.itemId, imported.itemId);
    assert.equal(replayedImport.assetId, imported.assetId);
    assert.equal(count(t.db, "items"), itemsBeforeImport + 1, "重放不新建 item");
    assert.equal(count(t.db, "assets"), assetsBeforeImport + 1, "重放不新建 asset");
    assert.equal(count(t.db, "import_stage_commits"), receiptsBeforeImport + 1, "重放不新增回执");

    // 旧下载端点不由本模块注册（P1T5 集成）
    res = await app.inject({ method: "POST", url: "/api/import/download", payload: {} });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    t.close();
  }
});
