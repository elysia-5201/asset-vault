/**
 * Task 4：stage token 与原子 commit（spec §5.4 / §6.4 / §9.1）。
 * 只连临时 DB 与临时文件；不碰 7317 / data / 真实素材；下载用注入 stub，不联网。
 *
 * 覆盖：
 *  - 原子提交：回执 + item + asset 同事务；attach 失败不回滚已成功登记。
 *  - 重放：同 token 200 返回旧指针；同 nonce 异 token 409；已提交指针失联 410；skip 空指针 200。
 *  - 同商品复用：同 (booth, source_item_id) 复用 item，只新增 asset。
 *  - 重启：epoch 变化 → 未提交 token 410 STAGE_TOKEN_INVALID。
 *  - 交错：事务外未命中 → A 提交 → B 事务内重查 200；失败整体回滚、nonce 未消费、可重试。
 *  - stage 只读：真实 stageDownload + 真实 precheck/hash，业务表零新增。
 *  - 默认 attach：省略 deps.attach 时真实 attachBoothMetadata 只附加元数据，保留 trashed/archived/active 状态。
 *  - stage 输入校验：非法/不一致 itemId 与 body root 在下载前 400；合法派生 id 绑定服务根。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { sha256Text } from "../../apps/server/src/util";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { createStageTokenCodec } from "../../apps/server/src/services/stage-token";
import { commitStageToken, commitStageTokenInTx, lookupReceipt, stageDownload, type CommitResult } from "../../apps/server/src/services/stage-commit";

/** 断言“新鲜 import”并收窄联合类型（skip/replay 分支没有 itemId/assetId）。 */
function asImported(r: CommitResult): { itemId: number; assetId: number } {
  if (r.replayed !== false || r.decision !== "import") throw new Error("expected fresh import result");
  return r;
}

/** 最小合法 BOOTH 元数据（attach 分支只要求形状存在；images 为空避免真实媒体 I/O）。 */
function minimalMeta(itemId: string) {
  return {
    itemId, title: "t", description: "", priceText: null, priceYen: null, publishedAt: null,
    isAdult: false, url: "https://booth.pm/ja/items/" + itemId, shop: null, tags: [], category: null,
    images: [], variations: [],
  };
}

test("commit 原子、重放 200、异 token 409、同商品复用、NULL 指针 410、重启 410、skip 200", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "AAA"); const st = statSync(f);
  const codec = createStageTokenCodec(Buffer.from("k1"), "ep1");
  const exp = Date.now() + 60_000;
  const token = codec.issue({ p: f, r: dir, i: "6115428", s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: exp, n: "n1" });
  let attachCalls = 0;
  const deps = {
    repo, media: {} as any, booth: { fetchItem: async (id: string) => minimalMeta(id) } as any,
    codec, log: () => {}, attach: async () => {},
  };
  const r1 = asImported(await commitStageToken({ ...deps, attach: async () => { attachCalls++; throw new Error("attach fail"); } }, token, "import"));
  assert.ok(r1.itemId && r1.assetId);
  assert.equal(attachCalls, 1, "attach 必须在 commit 成功后真实调用一次（best-effort 分支）");
  assert.equal(count(t.db, "import_stage_commits"), 1);
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 1);
  const rec1 = t.db.prepare("SELECT * FROM import_stage_commits WHERE nonce=?").get("n1") as any;
  assert.equal(rec1.decision, "import"); assert.equal(rec1.item_id, r1.itemId); assert.equal(rec1.asset_id, r1.assetId);
  assert.equal(rec1.token_hash, sha256Text(token));

  const r2 = await commitStageToken(deps, token, "import");
  assert.deepEqual(r2, { replayed: true, decision: "import", itemId: r1.itemId, assetId: r1.assetId });
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 1);

  const f2 = join(dir, "a2.zip"); writeFileSync(f2, "AAB");
  const same = codec.issue({ p: f2, r: dir, i: "6115428", s: 3, m: statSync(f2).mtime.toISOString(), h: sha256Text("AAB"), e: exp, n: "n8" });
  const r3 = asImported(await commitStageToken(deps, same, "import"));
  assert.equal(r3.itemId, r1.itemId);
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 2);

  // 同 nonce、异 token（显式改一个合法 claim：expiry+1000，不靠 Date.now 自然走时）→ 409，不返回他人指针。
  const other = codec.issue({ p: f, r: dir, i: "6115428", s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: exp + 1000, n: "n1" });
  await assert.rejects(() => commitStageToken(deps, other, "import"), (e: any) => e.details?.code === "STAGE_TOKEN_CONSUMED" && e.status === 409);

  // 已提交 import 回执指针失联（item 硬删 → assets CASCADE → 两个指针 SET NULL）→ 410，不重建。
  t.db.prepare("DELETE FROM items WHERE id=?").run(r1.itemId);
  const recAfter = t.db.prepare("SELECT * FROM import_stage_commits WHERE nonce=?").get("n1") as any;
  assert.equal(recAfter.item_id, null); assert.equal(recAfter.asset_id, null);
  await assert.rejects(() => commitStageToken(deps, token, "import"), (e: any) => e.details?.code === "STAGE_COMMITTED_OBJECT_DELETED" && e.status === 410);
  assert.equal(count(t.db, "items"), 0);

  // skip：只写回执（NULL 指针），不建业务行；同 token 重放 200。
  const skipToken = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: exp, n: "n10" });
  const s1 = await commitStageToken(deps, skipToken, "skip");
  assert.deepEqual(s1, { replayed: false, decision: "skip", skipped: true });
  assert.equal(count(t.db, "items"), 0); assert.equal(count(t.db, "assets"), 0);
  const recSkip = t.db.prepare("SELECT * FROM import_stage_commits WHERE nonce=?").get("n10") as any;
  assert.equal(recSkip.decision, "skip"); assert.equal(recSkip.item_id, null); assert.equal(recSkip.asset_id, null);
  assert.deepEqual(await commitStageToken(deps, skipToken, "skip"), { replayed: true, decision: "skip", itemId: null, assetId: null });

  // 重启：epoch 变化 → 未提交 token 410 STAGE_TOKEN_INVALID（回执未命中才验签）。
  const fresh = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: exp, n: "n9" });
  await assert.rejects(
    () => commitStageToken({ ...deps, codec: createStageTokenCodec(Buffer.from("k1"), "ep2") }, fresh, "import"),
    (e: any) => e.details?.code === "STAGE_TOKEN_INVALID" && e.status === 410,
  );
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("交错：事务外未命中 → A 提交 → B 事务内重查 200；失败回滚可重试", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "BBB"); const st = statSync(f);
  const codec = createStageTokenCodec(Buffer.from("k2"), "ep2");
  const token = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("BBB"), e: Date.now() + 60_000, n: "n2" });
  const deps = { repo, media: {} as any, booth: {} as any, codec, log: () => {}, attach: async () => {} };
  assert.equal(lookupReceipt(repo, "n2", sha256Text(token)).kind, "none");
  const a = asImported(await commitStageToken(deps, token, "import"));
  // 在真实外层事务里调用 InTx：证明它复用当前事务、不嵌套 BEGIN，且事务内重查回执返回 200。
  const b = repo.connection.transaction(() => commitStageTokenInTx(deps, codec.verify(token), sha256Text(token), "import")).immediate();
  assert.equal(typeof (b as any).then, "undefined", "事务内路径必须同步（无 await）");
  assert.deepEqual(b, { replayed: true, decision: "import", itemId: a.itemId, assetId: a.assetId });

  const orig = repo.upsertAsset.bind(repo);
  (repo as any).upsertAsset = () => { throw new Error("boom"); };
  const f3 = join(dir, "c.zip"); writeFileSync(f3, "CCC");
  const token2 = codec.issue({ p: f3, r: dir, i: null, s: 3, m: statSync(f3).mtime.toISOString(), h: sha256Text("CCC"), e: Date.now() + 60_000, n: "n3" });
  const itemsBefore = count(t.db, "items");
  await assert.rejects(() => commitStageToken(deps, token2, "import"));
  assert.equal(count(t.db, "import_stage_commits", "nonce=?", "n3"), 0, "失败必须整体回滚，nonce 未消费");
  assert.equal(count(t.db, "items"), itemsBefore, "失败不得留下空 item");
  (repo as any).upsertAsset = orig;
  const retry = asImported(await commitStageToken(deps, token2, "import"));
  assert.ok(retry.assetId);
  assert.equal(count(t.db, "import_stage_commits", "nonce=?", "n3"), 1);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("stage 只读：不建 item/asset/image/tag/category，token 绑定路径/size/hash/nonce", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage3-"));
  const f = join(dir, "c.zip"); writeFileSync(f, "CCC");
  const codec = createStageTokenCodec(Buffer.from("k3"), "ep3");
  const out = await stageDownload({
    repo, media: {} as any, booth: { fetchItem: async (id: string) => minimalMeta(id) } as any,
    codec, log: () => {}, dataDir: dir,
    download: async () => ({ path: f, bytes: 3, fileName: "c.zip", finalUrl: "x" }),
  }, { url: "https://booth.pm/ja/items/6115428" });
  assert.equal(out.staged, true); assert.ok(out.stageToken);
  assert.equal(out.bytes, 3); assert.equal(out.fileName, "c.zip");
  assert.equal(out.precheck.results.length, 1);
  assert.equal(out.precheck.results[0].summary, "none");
  const payload = codec.verify(out.stageToken);
  assert.equal(payload.p, f); assert.equal(payload.r, dir); assert.equal(payload.i, "6115428");
  assert.equal(payload.s, 3); assert.equal(payload.h, sha256Text("CCC")); assert.ok(payload.n);
  assert.equal(count(t.db, "items"), 0); assert.equal(count(t.db, "assets"), 0);
  assert.equal(count(t.db, "item_images"), 0); assert.equal(count(t.db, "tags"), 0);
  assert.equal(count(t.db, "categories"), 0);
  assert.equal(count(t.db, "import_stage_commits"), 0);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("归属门：new intent 跨 owner 409 且不消费 nonce；同已知商品 target 幂等", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage4-"));
  const f = join(dir, "d.zip"); writeFileSync(f, "DDD"); const st = statSync(f);
  const rootId = addRoot(t.db, normalizePath(dir), dir);
  const owner = addItem(t.db, { title: "owner" });
  addAsset(t.db, owner, rootId, normalizePath(f), { path: f, path_norm: normalizePath(f), size: 3 });
  const codec = createStageTokenCodec(Buffer.from("k4"), "ep4");
  const exp = Date.now() + 60_000;
  const deps = { repo, media: {} as any, booth: { fetchItem: async (id: string) => minimalMeta(id) } as any, codec, log: () => {}, attach: async () => {} };

  // new intent（i=null）遇到任何既有 owner → 409，不消费 nonce、不建 item。
  const newIntent = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("DDD"), e: exp, n: "n20" });
  await assert.rejects(() => commitStageToken(deps, newIntent, "import"),
    (e: any) => e.code === "CONFLICT" && e.status === 409 && e.details?.code === "PATH_OWNED_BY_OTHER_ITEM" && e.details?.itemId === owner);
  assert.equal(count(t.db, "import_stage_commits", "nonce=?", "n20"), 0);
  assert.equal(count(t.db, "items"), 1);

  // 已知商品号但库里没有该 item → 仍是 new intent → 同样冲突（不从碰撞 owner 反推 target）。
  const unknownProduct = codec.issue({ p: f, r: dir, i: "6115428", s: 3, m: st.mtime.toISOString(), h: sha256Text("DDD"), e: exp, n: "n21" });
  await assert.rejects(() => commitStageToken(deps, unknownProduct, "import"),
    (e: any) => e.details?.code === "PATH_OWNED_BY_OTHER_ITEM");
  assert.equal(count(t.db, "import_stage_commits", "nonce=?", "n21"), 0);

  // 同已知商品 target：新路径登记到该 item；同路径再次提交幂等（不新增 asset）。
  const boothItem = addItem(t.db, { source_site: "booth", source_item_id: "6115428", title: "booth" });
  const f2 = join(dir, "d2.zip"); writeFileSync(f2, "DDE");
  const known = codec.issue({ p: f2, r: dir, i: "6115428", s: 3, m: statSync(f2).mtime.toISOString(), h: sha256Text("DDE"), e: exp, n: "n22" });
  const first = asImported(await commitStageToken(deps, known, "import"));
  assert.equal(first.itemId, boothItem);
  assert.equal(count(t.db, "items"), 2); assert.equal(count(t.db, "assets"), 2);
  const again = codec.issue({ p: f2, r: dir, i: "6115428", s: 3, m: statSync(f2).mtime.toISOString(), h: sha256Text("DDE"), e: exp, n: "n23" });
  const second = asImported(await commitStageToken(deps, again, "import"));
  assert.equal(second.itemId, boothItem); assert.equal(second.assetId, first.assetId);
  assert.equal(count(t.db, "items"), 2); assert.equal(count(t.db, "assets"), 2);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("默认 attach（省略 deps.attach）：真实 attachBoothMetadata 只附加元数据，保留 trashed/archived/active 状态，不建 item/asset、不改 owner", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage5-"));
  const rootId = addRoot(t.db, normalizePath(dir), dir);
  const codec = createStageTokenCodec(Buffer.from("k5"), "ep5");
  const exp = Date.now() + 60_000;
  const cases = [
    { id: "6115428", status: "trashed" },
    { id: "6115429", status: "archived" },
    { id: "6115430", status: "active" },
  ] as const;
  let n = 0;
  for (const c of cases) {
    n++;
    const itemId = addItem(t.db, { source_site: "booth", source_item_id: c.id, title: "old-" + c.status, status: c.status });
    const prePath = join(dir, "pre-" + c.id + ".zip");
    const preAsset = addAsset(t.db, itemId, rootId, normalizePath(prePath), { path: prePath, path_norm: normalizePath(prePath), size: 1 });
    const f = join(dir, "new-" + c.id + ".zip"); writeFileSync(f, "NEW"); const st = statSync(f);
    const token = codec.issue({ p: f, r: dir, i: c.id, s: 3, m: st.mtime.toISOString(), h: sha256Text("NEW"), e: exp, n: "n-" + c.id });
    // 关键：不传 attach，走生产默认 attachBoothMetadata（真实 Repo + stub media/client，不联网）。
    const deps = {
      repo, media: {} as any,
      booth: { fetchItem: async (id: string) => ({ ...minimalMeta(id), title: "new-" + c.status }) } as any,
      codec, log: () => {},
    };
    const r = asImported(await commitStageToken(deps, token, "import"));
    assert.equal(r.itemId, itemId);
    const row = t.db.prepare("SELECT status, title FROM items WHERE id=?").get(itemId) as any;
    assert.equal(row.status, c.status, "attach-only 必须保留既有 status（" + c.status + "）");
    assert.equal(row.title, "new-" + c.status, "默认 attach 必须真实附加元数据");
    assert.equal(count(t.db, "items"), n, "attach 不得新建 item");
    assert.equal(count(t.db, "assets"), n * 2, "attach 不得新建 asset（每例：预登记 1 + commit 1）");
    const owner = t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(preAsset) as any;
    assert.equal(owner.item_id, itemId, "attach 不得改 asset owner");
  }
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("stageDownload 输入校验：非法/不一致 itemId 与 body root 在下载前 400；合法派生 id 与相同根绑定服务根", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage6-"));
  const other = mkdtempSync(join(tmpdir(), "av-stage6-other-"));
  const f = join(dir, "e.zip"); writeFileSync(f, "EEE");
  const codec = createStageTokenCodec(Buffer.from("k6"), "ep6");
  let calls = 0;
  const download = async () => { calls++; return { path: f, bytes: 3, fileName: "e.zip", finalUrl: "x" }; };
  // 服务根 = deps.downloadRoot（不是 dataDir）；body.downloadRoot 只能与它一致。
  const deps = {
    repo, media: {} as any, booth: { fetchItem: async (id: string) => minimalMeta(id) } as any,
    codec, log: () => {}, dataDir: other, downloadRoot: dir, download,
  };
  const bad = async (body: any, label: string) => {
    calls = 0;
    await assert.rejects(() => stageDownload(deps, body), (e: any) => e.code === "INVALID_INPUT" && e.status === 400, label);
    assert.equal(calls, 0, label + "：必须在下载前拒绝（download 0 调用）");
    assert.equal(count(t.db, "items"), 0); assert.equal(count(t.db, "assets"), 0);
    assert.equal(count(t.db, "import_stage_commits"), 0);
  };
  await bad({ url: "https://booth.pm/ja/items/6115428", itemId: "../6115428" }, "itemId 含目录分隔");
  await bad({ url: "https://booth.pm/ja/items/6115428", itemId: "6115428/../x" }, "itemId 含片段");
  await bad({ url: "https://booth.pm/ja/items/6115428", itemId: { id: "6115428" } }, "itemId 对象");
  await bad({ url: "https://booth.pm/ja/items/6115428", itemId: "1234" }, "itemId 位数不足");
  await bad({ url: "https://booth.pm/ja/items/6115428", itemId: "6115429" }, "URL/body 商品号不一致");
  await bad({ url: "https://booth.pm/ja/items/6115428", downloadRoot: other }, "body root 与服务根不同");

  // 正对照：URL 派生 id + body 相同根 → token 绑定服务根与派生 id。
  calls = 0;
  const ok = await stageDownload(deps, { url: "https://booth.pm/ja/items/6115428", downloadRoot: dir });
  assert.equal(calls, 1);
  const p1 = codec.verify(ok.stageToken);
  assert.equal(p1.i, "6115428"); assert.equal(p1.r, dir);
  // 正对照：body 显式相同 id（字符串/安全整数）都接受。
  const ok2 = await stageDownload(deps, { url: "https://booth.pm/ja/items/6115428", itemId: "6115428" });
  assert.equal(codec.verify(ok2.stageToken).i, "6115428");
  const ok3 = await stageDownload(deps, { url: "https://booth.pm/ja/items/6115428", itemId: 6115428 });
  assert.equal(codec.verify(ok3.stageToken).i, "6115428");
  // 正对照：非商品 BOOTH 下载 URL + 无 itemId → 允许 null 普通下载（不要求商品号）。
  const ok4 = await stageDownload(deps, { url: "https://booth.pm/ja/downloadables/1448437" });
  assert.equal(codec.verify(ok4.stageToken).i, null);
  rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); t.close();
});
