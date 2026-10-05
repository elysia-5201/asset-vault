import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareFingerprints,
  guidHashOf,
  parseVersionKey,
  similarityOf,
  structHashOf,
  type EntryLike,
  type Fingerprint,
} from "../src/dedupe";

/** 造指纹：只写关心的字段，其余留空。 */
function fp(p: Partial<Fingerprint> & { assetId: number; itemId: number }): Fingerprint {
  return { container: "zip", fileSha: null, structHash: null, guidHash: null, entries: [], guids: [], versionKey: null, ...p };
}
const e = (path: string, size: number): EntryLike => ({ path, size });

// ---------------------------------------------------------------- 字节相同

test("dedupe: SHA256 一致 → exact（不管条目清单是否相同）", () => {
  const a = fp({ assetId: 1, itemId: 10, fileSha: "a".repeat(64), entries: [e("Assets/x.mat", 10)] });
  const b = fp({ assetId: 2, itemId: 20, fileSha: "a".repeat(64), entries: [e("Assets/y.mat", 99)] });
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 1);
  assert.equal(m.level, "exact");
  assert.equal(m.reason, "字节完全相同（SHA256 一致）");
  assert.deepEqual(m.diff, { added: [], removed: [], changed: [] });
  assert.equal(m.otherAssetId, 2);
  assert.equal(m.otherItemId, 20);
});

// ---------------------------------------------------------------- 内容一致

test("dedupe: 条目集合完全一致但 sha 不同 → same-content 1.0（大小写/顺序/压缩方式不影响）", () => {
  const a = fp({ assetId: 1, itemId: 10, fileSha: "aa", entries: [e("Assets/A.mat", 10), e("Assets/B.png", 20)] });
  const b = fp({ assetId: 2, itemId: 20, fileSha: "bb", entries: [e("assets/b.png", 20), e("assets/a.mat", 10)] });
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 1);
  assert.equal(m.level, "same-content");
  assert.deepEqual(m.diff, { added: [], removed: [], changed: [] });
  assert.match(m.reason, /新增 0 \/ 删除 0 \/ 修改 0/);
});

test("dedupe: 同一路径重复出现取 size 最大的一条（否则会把正常包判成改过）", () => {
  const a = fp({ assetId: 1, itemId: 10, fileSha: "aa", entries: [e("Assets/A.mat", 5), e("Assets/a.mat", 9)] });
  const b = fp({ assetId: 2, itemId: 20, fileSha: "bb", entries: [e("assets/a.mat", 9)] });
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 1);
  assert.equal(m.level, "same-content");
});

// ---------------------------------------------------------------- 版本差异

test("dedupe: v1.0 vs v1.1（+2 新增 / 1 修改）→ 分数按公式钉死 0.5833", () => {
  const a = fp({
    assetId: 1, itemId: 10, fileSha: "s1", versionKey: "1.0",
    entries: [e("a.txt", 100), e("b.txt", 200), e("c.txt", 300), e("d.txt", 400)],
  });
  const b = fp({
    assetId: 2, itemId: 20, fileSha: "s2", versionKey: "1.1",
    entries: [e("a.txt", 100), e("b.txt", 200), e("c.txt", 350), e("d.txt", 400), e("e.txt", 500), e("f.txt", 600)],
  });
  // same=3 changed=1 added=2 removed=0 union=6 → (3 + 0.5) / 6 = 0.58333… → 0.5833
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 0.5833);
  assert.equal(m.level, "near");
  assert.match(m.reason, /新增 2 \/ 删除 0 \/ 修改 1/);
  assert.deepEqual(m.diff.added, [e("e.txt", 500), e("f.txt", 600)]);
  assert.deepEqual(m.diff.removed, []);
  assert.deepEqual(m.diff.changed, [e("c.txt", 350)]); // 修改取 b 侧大小
  assert.equal(similarityOf(a, b, 0.5833)?.similarity, 0.5833); // 恰好等于阈值 → 保留
  assert.equal(similarityOf(a, b, 0.9), null);                  // 低于阈值 → null
});

// ---------------------------------------------------------------- GUID 一路

test("dedupe: 条目路径完全不同但 GUID 清单一致 → 相似度由 GUID 决定（=1）", () => {
  const a = fp({
    assetId: 1, itemId: 10, container: "unitypackage", fileSha: "s1",
    entries: [e("Assets/A/x.mat", 10), e("Assets/A/y.png", 20)], guids: ["g1", "g2", "g3"],
  });
  const b = fp({
    assetId: 2, itemId: 20, container: "unitypackage", fileSha: "s2",
    entries: [e("Assets/B/p.mat", 10), e("Assets/B/q.png", 20)], guids: ["G1", "g3", "g2"],
  });
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 1);          // 条目一路是 0，由 GUID 一路拉满
  assert.equal(m.level, "near");          // 1.0 但 diff 非空 → 不是 same-content
  assert.equal(m.diff.added.length, 2);
  assert.equal(m.diff.removed.length, 2);
  assert.match(m.reason, /GUID 交集 3\/3/);
});

test("dedupe: GUID 部分命中 → simGuids = 交集/并集（两路取 max）", () => {
  const a = fp({ assetId: 1, itemId: 10, container: "unitypackage", fileSha: "s1", entries: [e("a/x", 1)], guids: ["g1", "g2", "g3"] });
  const b = fp({ assetId: 2, itemId: 20, container: "unitypackage", fileSha: "s2", entries: [e("b/x", 1)], guids: ["g2", "g3", "g4"] });
  const m = compareFingerprints(a, b);
  assert.equal(m.similarity, 0.5); // 2/4
});

test("dedupe: 压缩包只有 GUID 聚合哈希（拿不到清单）时，哈希相等即可判同一批包", () => {
  const g = guidHashOf(["g1", "g2"]);
  const a = fp({ assetId: 1, itemId: 10, container: "zip", fileSha: "s1", entries: [e("a/x", 1)], guids: [], guidHash: g });
  const b = fp({ assetId: 2, itemId: 20, container: "zip", fileSha: "s2", entries: [e("b/x", 1)], guids: [], guidHash: g });
  assert.equal(compareFingerprints(a, b).similarity, 1);
});

// ---------------------------------------------------------------- 阈值 / 空清单

test("dedupe: 两路都没有可比信息（空清单）→ similarity 0，阈值 0.9 下返回 null", () => {
  const a = fp({ assetId: 1, itemId: 10, fileSha: "s1" });
  const b = fp({ assetId: 2, itemId: 20, fileSha: "s2" });
  assert.equal(similarityOf(a, b, 0.9), null);
  assert.equal(compareFingerprints(a, b).similarity, 0);
});

// ---------------------------------------------------------------- diff 上限

test("dedupe: diff 按 path 排序、每类最多 50 条，reason 里给全量总数", () => {
  const oldEntries: EntryLike[] = [];
  const newEntries: EntryLike[] = [];
  for (let i = 0; i < 80; i++) {
    const n = String(i).padStart(2, "0");
    oldEntries.push(e("old/" + n + ".txt", 10));
    newEntries.push(e("new/" + n + ".txt", 10));
  }
  const m = compareFingerprints(
    fp({ assetId: 1, itemId: 10, fileSha: "s1", entries: oldEntries }),
    fp({ assetId: 2, itemId: 20, fileSha: "s2", entries: newEntries }),
  );
  assert.equal(m.diff.added.length, 50);
  assert.equal(m.diff.removed.length, 50);
  assert.equal(m.diff.changed.length, 0);
  assert.equal(m.diff.added[0]!.path, "new/00.txt");   // 排序后取前 50
  assert.equal(m.diff.removed[49]!.path, "old/49.txt");
  assert.match(m.reason, /新增 80 \/ 删除 80 \/ 修改 0/);
  assert.equal(m.similarity, 0);
});

// ---------------------------------------------------------------- 指纹辅助函数

test("structHashOf: 只与「归一化路径 + 最大 size」有关（顺序/大小写无关，size 变了就变）", () => {
  const h1 = structHashOf([e("Assets/A.mat", 10), e("Assets/B.png", 20)]);
  const h2 = structHashOf([e("assets/b.png", 20), e("assets/a.mat", 10)]);
  const h3 = structHashOf([e("Assets/A.mat", 11), e("Assets/B.png", 20)]);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("guidHashOf: 大小写/顺序/重复无关", () => {
  assert.equal(guidHashOf(["ABC", "def", "abc"]), guidHashOf(["def", "abc"]));
  assert.notEqual(guidHashOf(["abc"]), guidHashOf(["abd"]));
});

// ---------------------------------------------------------------- 版本号解析

test("parseVersionKey: 正例（前缀式 / 裸 x.y / 全角）", () => {
  assert.equal(parseVersionKey("Ribbon_Hair_Accessory_v1.2"), "1.2");
  assert.equal(parseVersionKey("Star_Earrings_Set_V1.0.zip"), "1.0");
  assert.equal(parseVersionKey("Pack_ver1.2.zip"), "1.2");
  assert.equal(parseVersionKey("Pack ver 1.2.zip"), "1.2");
  assert.equal(parseVersionKey("Version 2.1"), "2.1");
  assert.equal(parseVersionKey("Winter_Coat_Outfit_v2.0"), "2.0");
  assert.equal(parseVersionKey("Pack_1.2.0.zip"), "1.2.0");
  assert.equal(parseVersionKey("Pack_1.2_"), "1.2");
  assert.equal(parseVersionKey("パック_v１.２.zip"), "1.2"); // 全角数字
  assert.equal(parseVersionKey("素材 v1.2"), "1.2");
});

test("parseVersionKey: 反例（纯数字年份/尺寸不是版本号）", () => {
  assert.equal(parseVersionKey("2025.zip"), null);
  assert.equal(parseVersionKey("2025"), null);
  assert.equal(parseVersionKey("1080"), null);
  assert.equal(parseVersionKey("Danzai_Bunny.zip"), null);
  assert.equal(parseVersionKey("ReadMe.txt"), null);
  assert.equal(parseVersionKey(""), null);
});
