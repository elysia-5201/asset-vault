/**
 * v0.6.0 流水线契约测试 —— DerivedCache（verifier）
 * 覆盖：cacheKey 稳定性/敏感性、put/get、版本变更 miss、坏 JSON 自愈、原子写(tmp+rename)、
 *       gc(LRU+过期+keepEntries)、pruneTemp、drop 拒绝 root 之外路径、clear/stats。
 * 实现：apps/server/src/services/pipeline/cache.ts（不改实现）
 * 依赖：test/schema/_db.ts 的临时库（真实 schema）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { DerivedCache, cacheKey } from "../../apps/server/src/services/pipeline/cache";

let t: TempDb;
let repo: Repo;
let root: string;
let cache: DerivedCache;

beforeEach(() => {
  t = openTempDb();
  repo = new Repo(t.db);
  root = mkdtempSync(join(tmpdir(), "av-cache-"));
  cache = new DerivedCache(root, repo, () => {});
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  t.close();
});

const parts = (over: Partial<Parameters<typeof cacheKey>[0]> = {}) => ({
  kind: "archive-listing", identity: "sha256:abc", versionKey: "v1", ...over,
});

/** 递归列出 root 下所有文件（相对路径）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p.slice(root.length + 1));
  }
  return out;
}

describe("cacheKey", () => {
  test("同输入稳定；每个组成部分变化都会变键", () => {
    const base = cacheKey(parts());
    assert.equal(cacheKey(parts()), base);
    assert.match(base, /^[a-f0-9]{64}$/);
    const variants = [
      parts({ kind: "unitypackage" }),
      parts({ identity: "sha256:def" }),
      parts({ versionKey: "v2" }),
      parts({ limitsHash: "abcd" }),
      parts({ extra: { size: 1 } }),
      parts({ extra: { size: 2 } }),
    ];
    for (const v of variants) assert.notEqual(cacheKey(v), base, JSON.stringify(v));
  });

  test("extra 的键顺序无关（同一组参数 → 同键）", () => {
    const a = cacheKey(parts({ extra: { a: 1, b: 2 } }));
    const b = cacheKey(parts({ extra: { b: 2, a: 1 } }));
    assert.equal(a, b);
  });

  test("键不含路径/文件名（identity 之外没有隐式输入）", () => {
    // 相同 parts 即使调用侧来自不同文件路径也必须同键（签名里没有 path 参数）
    assert.equal(cacheKey(parts()), cacheKey(parts()));
  });
});

describe("put / get 基础", () => {
  test("put 后 get 命中；DB 登记 ready 且文件存在；hits 增加", async () => {
    const key = cacheKey(parts());
    const r = await cache.put("archive-listing", key, { entries: [1, 2, 3] }, { kind: "archive-listing", versionKey: "v1" });
    assert.ok(r.bytes > 0);
    const entry = repo.getCacheEntry(key);
    assert.ok(entry, "cache_entries 未登记");
    assert.equal(entry.state, "ready");
    assert.ok(existsSync(entry.file_path));
    assert.deepEqual(await cache.get("archive-listing", key), { entries: [1, 2, 3] });
    assert.equal(cache.stats(1e9).hits, 1);
    assert.equal(cache.stats(1e9).entries, 1);
  });

  test("版本变 → miss（不同版本键查不到旧值）", async () => {
    const k1 = cacheKey(parts({ versionKey: "v1" }));
    const k2 = cacheKey(parts({ versionKey: "v2" }));
    await cache.put("archive-listing", k1, { v: 1 }, { kind: "archive-listing", versionKey: "v1" });
    assert.deepEqual(await cache.get("archive-listing", k1), { v: 1 });
    assert.equal(await cache.get("archive-listing", k2), null, "版本变化后必须 miss");
  });

  test("limitsHash 变 → miss（限制改变不能让旧结果冒充新结果）", async () => {
    const k1 = cacheKey(parts());
    const k2 = cacheKey(parts({ limitsHash: "changed" }));
    await cache.put("archive-listing", k1, { n: 20000 }, { kind: "archive-listing", versionKey: "v1" });
    assert.equal(await cache.get("archive-listing", k2), null);
  });

  test("未登记/未写入 → null（不抛）", async () => {
    assert.equal(await cache.get("archive-listing", cacheKey(parts({ identity: "nope" }))), null);
  });

  test("重复 put 同键 → 覆盖内容且 DB 只有一行", async () => {
    const key = cacheKey(parts());
    await cache.put("archive-listing", key, { v: 1 }, { kind: "archive-listing", versionKey: "v1" });
    await cache.put("archive-listing", key, { v: 2 }, { kind: "archive-listing", versionKey: "v1" });
    assert.deepEqual(await cache.get("archive-listing", key), { v: 2 });
    assert.equal(repo.listCacheEntries("archive-listing", 10).length, 1);
  });
});

describe("自愈 / 原子性", () => {
  test("坏 JSON → get null、文件与 DB 条目被清、不抛", async () => {
    const key = cacheKey(parts());
    await cache.put("archive-listing", key, { ok: true }, { kind: "archive-listing", versionKey: "v1" });
    const entry = repo.getCacheEntry(key);
    writeFileSync(entry.file_path, "{not json");
    assert.equal(await cache.get("archive-listing", key), null);
    assert.equal(repo.getCacheEntry(key), null, "坏条目必须从 cache_entries 清掉");
    assert.equal(existsSync(entry.file_path), false, "坏文件应被删除");
  });

  test("文件被外部删除 → get null 且 DB 条目被清", async () => {
    const key = cacheKey(parts());
    await cache.put("archive-listing", key, { ok: true }, { kind: "archive-listing", versionKey: "v1" });
    const entry = repo.getCacheEntry(key);
    rmSync(entry.file_path);
    assert.equal(await cache.get("archive-listing", key), null);
    assert.equal(repo.getCacheEntry(key), null);
  });

  test("put 使用 tmp+rename：写完不留 *.tmp-* 残留", async () => {
    for (let i = 0; i < 5; i++) {
      await cache.put("archive-listing", cacheKey(parts({ identity: "s" + i })), { i }, { kind: "archive-listing", versionKey: "v1" });
    }
    const leftovers = walk(root).filter((p) => p.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "残留临时文件: " + leftovers.join(","));
  });

  test("pruneTemp 只清缓存根内的 .tmp-*，根外文件不动", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "av-cache-outside-"));
    try {
      mkdirSync(join(root, "archive-listing"), { recursive: true });
      writeFileSync(join(root, "archive-listing", "dead.tmp-123"), "x");
      writeFileSync(join(root, "archive-listing", "keep.json"), "{}");
      const outside = join(outsideDir, "outside.tmp-999");
      writeFileSync(outside, "x");
      const removed = cache.pruneTemp();
      assert.equal(removed, 1);
      assert.equal(existsSync(join(root, "archive-listing", "dead.tmp-123")), false);
      assert.equal(existsSync(join(root, "archive-listing", "keep.json")), true);
      assert.equal(existsSync(outside), true, "根外文件绝不能被 pruneTemp 删掉");
    } finally { rmSync(outsideDir, { recursive: true, force: true }); }
  });

  test("drop 拒绝删除缓存根之外的路径（安全边界）", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "av-cache-outside2-"));
    try {
      const outside = join(outsideDir, "precious.json");
      writeFileSync(outside, "do-not-delete");
      const key = cacheKey(parts({ identity: "outside" }));
      repo.upsertCacheEntry({ key, kind: "archive-listing", versionKey: "v1", filePath: outside, bytes: 5 });
      cache.drop(key);
      assert.equal(existsSync(outside), true, "root 之外的路径必须拒绝删除");
      assert.equal(repo.getCacheEntry(key), null, "DB 条目仍应清掉（否则永远命中坏路径）");
    } finally { rmSync(outsideDir, { recursive: true, force: true }); }
  });
});

describe("gc / clear / stats", () => {
  const mk = async (n: number, body = "x".repeat(1000)) => {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const key = cacheKey(parts({ identity: "gc" + i }));
      keys.push(key);
      await cache.put("archive-listing", key, { body }, { kind: "archive-listing", versionKey: "v1" });
      // 直接控制 last_used_at：i 越大越新
      t.db.prepare("UPDATE cache_entries SET last_used_at=? WHERE key=?").run(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), key);
    }
    return keys;
  };

  test("按 last_used_at LRU 淘汰到 maxBytes 以下，keepEntries 保护最近使用", async () => {
    const keys = await mk(5);
    const before = cache.stats(1e9);
    assert.equal(before.entries, 5);
    const r = cache.gc({ maxBytes: 2500, maxAgeDays: 3650, keepEntries: 1 });
    assert.equal(r.removed, 3, "5000B → 需删 3 条才能 ≤2500B");
    assert.equal(repo.cacheStats().entries, 2);
    // 最旧的 3 条被删，最近两条留下
    assert.deepEqual([keys[0], keys[1], keys[2]].map((k) => repo.getCacheEntry(k)), [null, null, null]);
    assert.ok(repo.getCacheEntry(keys[3]) && repo.getCacheEntry(keys[4]));
  });

  test("过期优先删除（maxAgeDays）", async () => {
    const keys = await mk(3);
    // 只让 keys[0] 过期；另外两条刷成"最近使用"，避免被 maxAgeDays 一起判死
    t.db.prepare("UPDATE cache_entries SET last_used_at=? WHERE key=?").run("2020-01-01T00:00:00.000Z", keys[0]);
    for (const k of [keys[1], keys[2]]) t.db.prepare("UPDATE cache_entries SET last_used_at=? WHERE key=?").run(new Date().toISOString(), k);
    const r = cache.gc({ maxBytes: 1e9, maxAgeDays: 30, keepEntries: 0 });
    assert.equal(r.expired, 1);
    assert.equal(repo.getCacheEntry(keys[0]), null);
    assert.ok(repo.getCacheEntry(keys[1]));
  });

  test("clear(kind) 只清指定 kind", async () => {
    await cache.put("archive-listing", cacheKey(parts({ kind: "archive-listing" })), { a: 1 }, { kind: "archive-listing", versionKey: "v1" });
    await cache.put("thumbs", cacheKey(parts({ kind: "thumbs" })), { b: 2 }, { kind: "thumbs", versionKey: "v1" });
    const removed = cache.clear("archive-listing");
    assert.equal(removed, 1);
    assert.equal(repo.listCacheEntries("archive-listing", 10).length, 0);
    assert.equal(repo.listCacheEntries("thumbs", 10).length, 1);
  });

  test("stats：entries/bytes/hits/hitRate/maxBytes/oldest 语义", async () => {
    const k = cacheKey(parts({ identity: "stat" }));
    await cache.put("archive-listing", k, { v: 1 }, { kind: "archive-listing", versionKey: "v1" });
    await cache.get("archive-listing", k);
    await cache.get("archive-listing", cacheKey(parts({ identity: "miss" })));
    const s = cache.stats(12345);
    assert.equal(s.entries, 1);
    assert.ok(s.bytes > 0);
    assert.equal(s.hits, 1);
    assert.equal(s.hitRate, 0.5, "1 命中 / 2 次 get");
    assert.equal(s.maxBytes, 12345);
    assert.ok(s.oldest);
  });
});
