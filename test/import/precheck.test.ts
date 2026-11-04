import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { sha256Buffer } from "../../packages/core/src/hash";
import { precheckPaths } from "../../apps/server/src/services/precheck";

test("exact 只由 stat 一致 + 本次重算相等得出", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "AAA");
  const st = statSync(f);
  const itemId = addItem(t.db, { title: "A" });
  const assetId = addAsset(t.db, itemId, rootId, f, { path: f, path_norm: f, size: 3, mtime: st.mtime.toISOString(), sha256: sha256Buffer(Buffer.from("AAA")), sha256_state: "ok" });
  const before = { items: count(t.db, "items"), assets: count(t.db, "assets") };
  const r = await precheckPaths({ repo }, { paths: [f] });
  assert.equal(r.results[0].match.exact?.assetId, assetId);
  assert.equal(r.results[0].match.exact?.rehashVerified, true);
  assert.equal(r.results[0].summary, "exact");
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  const src = readFileSync(new URL("../../apps/server/src/services/precheck.ts", import.meta.url), "utf8");
  assert.ok(!/computeSignature|fingerprintOf|findDuplicatesForItem|mergeItems/.test(src));
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("陈旧/保持时间戳/预算不足都不 exact", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "AAA");
  const st = statSync(f);
  const itemId = addItem(t.db, { title: "B" });
  addAsset(t.db, itemId, rootId, f, { path: f, path_norm: f, size: 3, mtime: st.mtime.toISOString(), sha256: sha256Buffer(Buffer.from("AAA")), sha256_state: "ok" });
  utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  assert.equal((await precheckPaths({ repo }, { paths: [f] })).results[0].match.weak?.reason, "existing_hash_stale");
  writeFileSync(f, "BBB"); utimesSync(f, st.atime, st.mtime);
  assert.equal((await precheckPaths({ repo }, { paths: [f] })).results[0].match.weak?.reason, "existing_hash_mismatch");
  assert.equal((await precheckPaths({ repo }, { paths: [f], budget: { maxBytes: 4 } })).results[0].match.weak?.reason, "existing_hash_unverified");
  const ac = new AbortController(); ac.abort();
  assert.equal((await precheckPaths({ repo }, { paths: [f] }, ac.signal)).results[0].hash.state, "unknown");
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("同商品版本候选、不可解析、路径冲突", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre3-"));
  const old = join(dir, "6115428_v1.2.zip"); writeFileSync(old, "OLD");
  const itemId = addItem(t.db, { title: "6115428", source_site: "booth", source_item_id: "6115428" });
  addAsset(t.db, itemId, rootId, old, { path: old, path_norm: old, size: 3, mtime: statSync(old).mtime.toISOString() });
  const inc = join(dir, "6115428_v1.3.zip"); writeFileSync(inc, "NEW");
  const r = await precheckPaths({ repo }, { paths: [inc] });
  assert.equal(r.results[0].match.sameProduct?.itemId, itemId);
  assert.equal(r.results[0].match.version?.relation, "newer");
  assert.equal(r.results[0].match.version?.proven, false);
  const odd = join(dir, "6115428_2025.zip"); writeFileSync(odd, "X");
  assert.equal((await precheckPaths({ repo }, { paths: [odd] })).results[0].match.version?.relation, "unknown");
  // A17：未识别 sameProduct 时，路径属于别的 item → sameItem:false（不是幂等）。
  // 固定子目录名，避免 mkdtemp 随机后缀偶然出现 5..9 位数字串。
  const plainDir = join(dir, "plain"); mkdirSync(plainDir);
  const owned = join(plainDir, "owned.zip"); writeFileSync(owned, "OWN");
  addAsset(t.db, itemId, rootId, owned, { path: owned, path_norm: owned, size: 3 });
  const c = await precheckPaths({ repo }, { paths: [owned] });
  assert.equal(c.results[0].match.sameProduct, null);
  assert.equal(c.results[0].match.pathCollision?.itemId, itemId);
  assert.equal(c.results[0].match.pathCollision?.sameItem, false);

  // 正例：识别到 sameProduct 且 owner 就是该 item → sameItem:true（幂等）。
  const same = join(dir, "6115428_same.zip"); writeFileSync(same, "SAME");
  addAsset(t.db, itemId, rootId, same, { path: same, path_norm: same, size: 4 });
  const s = await precheckPaths({ repo }, { paths: [same] });
  assert.equal(s.results[0].match.sameProduct?.itemId, itemId);
  assert.equal(s.results[0].match.pathCollision?.sameItem, true);

  // 反例：识别到 sameProduct，但路径 owner 是另一个 item → sameItem:false。
  const otherItemId = addItem(t.db, { title: "Other", source_site: "booth", source_item_id: "9999999" });
  const other = join(dir, "6115428_other.zip"); writeFileSync(other, "OTHER");
  addAsset(t.db, otherItemId, rootId, other, { path: other, path_norm: other, size: 5 });
  const o = await precheckPaths({ repo }, { paths: [other] });
  assert.equal(o.results[0].match.sameProduct?.itemId, itemId);
  assert.equal(o.results[0].match.pathCollision?.itemId, otherItemId);
  assert.equal(o.results[0].match.pathCollision?.sameItem, false);
  rmSync(dir, { recursive: true, force: true }); t.close();
});
