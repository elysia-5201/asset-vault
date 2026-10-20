/**
 * AUD-03 弱身份缓存对抗脚本（只读审计工具，不参与生产构建）
 *
 * 目的：用真实 stage/Repo/DerivedCache（无桩替身）逐条验证 v0.6.1 缓存身份假设：
 *   1) 跨资产同 size+mtime 是否撞键
 *   2) rename 替换（新 inode）
 *   3) cp -p 覆盖（同 inode、同 size、同 mtime）        ← 残差重点
 *   4) 原地写 + 回写 mtime（同 inode）
 *   5) 陈旧 sha 窗口（同 size+mtime 替换后 scan 不重置 sha）
 *   6) 强键污染（解析结果被写进旧 sha 的键）
 *   7) 强身份跨路径同内容复用（正确性对照）
 *   8) ino/dev 退化（Windows ino=0 时的键形态）
 *   9) inode 复用探测（unlink 后重建是否复用 ino）
 *
 * 用法：node --import tsx scripts/audit-cache-identity-adversarial.ts [--json]
 * 产物：仅临时目录（/tmp）与一次性 SQLite 临时库；不触碰 data/。
 */
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot } from "../test/schema/_db";
import { Repo } from "../apps/server/src/db/repo";
import { DerivedCache, cacheKey } from "../apps/server/src/services/pipeline/cache";
import { contentIdentity, contentSample, stageArchive, type LiveStat, type StageCtx } from "../apps/server/src/services/pipeline/stages";
import { DEFAULT_LIMITS, type PipelineLimits } from "../apps/server/src/services/pipeline/limits";
import { ARCHIVE_PARSER_VERSION, listArchive } from "../packages/core/src/archive/list";
import { buildZip } from "../packages/core/test/content/fixtures";
import type { AssetRow } from "../packages/core/src/contracts";

interface Row { id: string; scenario: string; expected: "HIT" | "MISS"; observed: "HIT" | "MISS"; verdict: "SAFE" | "VULN"; detail: string }

const rows: Row[] = [];
const probes: string[] = [];
const t = openTempDb();
const repo = new Repo(t.db);
const cacheRoot = mkdtempSync(join(tmpdir(), "aud03-cache-"));
const cache = new DerivedCache(cacheRoot, repo, () => {});
const work = mkdtempSync(join(tmpdir(), "aud03-fixtures-"));
const itemId = addItem(t.db, { title: "aud03" });
const rootId = addRoot(t.db, "/lib");
const LIMITS: PipelineLimits = { ...DEFAULT_LIMITS, maxArchiveBytes: 0 };

const liveOf = (p: string): LiveStat => {
  const st = statSync(p);
  return { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino), dev: Number(st.dev) };
};

/** A/B 两个内容不同、字节数相同、mtime 相同的 zip。 */
function twins(tag: string): { a: string; b: string; at: Date } {
  const a = join(work, tag + "-A.zip");
  const b = join(work, tag + "-B.zip");
  writeFileSync(a, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
  writeFileSync(b, buildZip([{ name: "b1.txt", data: Buffer.alloc(100, 0x62) }]));
  const at = new Date("2026-04-05T06:07:08.900Z");
  utimesSync(a, at, at);
  utimesSync(b, at, at);
  return { a, b, at };
}

function register(path: string, o: { sha?: string | null } = {}): AssetRow {
  const st = statSync(path);
  const { asset } = repo.upsertAsset({
    item_id: itemId, kind: "archive", container: "zip", path, path_norm: path.toLowerCase(), root_id: rootId,
    size: st.size, mtime: st.mtime.toISOString(), discovered_by: "scan",
  });
  if (o.sha) repo.setAssetSha(asset.id, o.sha, "ok");
  return repo.getAsset(asset.id)!;
}

function ctx(): StageCtx {
  return { repo, media: {} as never, cache, limits: LIMITS, log: () => {}, signal: new AbortController().signal, progress: () => {} };
}

const isHit = (note: unknown): boolean => /cache hit/.test(String(note));
const pathsOf = (assetId: number): string[] => repo.getArchiveEntries(assetId).map((e: any) => e.path);
const sampleOf = async (p: string): Promise<string | null> => contentSample(p, statSync(p).size);
const keyFor = (identity: string, sample: string | null): string => cacheKey({
  kind: "archive-listing", identity, versionKey: "archive:zip:v" + ARCHIVE_PARSER_VERSION,
  limitsHash: cacheKey({ kind: "limits", identity: "l", versionKey: "", extra: {
    maxEntries: LIMITS.maxArchiveEntries, maxEntryBytes: LIMITS.maxEntryBytes,
    maxTotalReadBytes: LIMITS.maxTotalReadBytes, maxCompressionRatio: LIMITS.maxCompressionRatio,
  } }),
  extra: { sample: sample ?? "unreadable" },
});

function record(id: string, scenario: string, expected: "HIT" | "MISS", observed: "HIT" | "MISS", detail: string): void {
  rows.push({ id, scenario, expected, observed, verdict: observed === expected ? "SAFE" : "VULN", detail });
}

/** FIX-05 前提：替换前后采样必须不同，否则这一行的结论没有意义。 */
function assertSampleDiff(a: string | null, b: string | null): void {
  if (a === b) throw new Error("sample 未变化，FIX-05 前提不成立（a=" + a + " b=" + b + "）");
}


/** v0.6.2/FIX-05 前后对比（--bench）：500 文件冷/热/替换混合三轮。 */
async function bench(): Promise<void> {
  const N = 500;
  const files: string[] = [];
  for (let i = 0; i < N; i++) {
    const p = join(work, "bench-" + i + ".zip");
    writeFileSync(p, buildZip([{ name: "e" + i + ".txt", data: Buffer.alloc(100 + (i % 7), 0x61) }]));
    files.push(p);
  }
  const assets: AssetRow[] = [];
  for (const p of files) assets.push(register(p));

  let h1 = 0;
  let t = process.hrtime.bigint();
  for (const a of assets) { const r = await stageArchive(ctx(), a); if (isHit(r.note)) h1++; }
  const coldMs = Number(process.hrtime.bigint() - t) / 1e6;

  let h2 = 0;
  t = process.hrtime.bigint();
  for (const a of assets) { const r = await stageArchive(ctx(), a); if (isHit(r.note)) h2++; }
  const warmMs = Number(process.hrtime.bigint() - t) / 1e6;

  t = process.hrtime.bigint();
  for (const p of files) await contentSample(p, statSync(p).size);
  const sampleMs = Number(process.hrtime.bigint() - t) / 1e6;

  // 替换 50 个：cp -p 就地覆盖，size 与 mtime 不变，条目名 e<i>.txt → x<i>.txt（同长度）
  const replaced = new Set<number>();
  for (let k = 0; k < 50; k++) {
    const i = k * 10;
    const src = join(work, "bench-alt-" + i + ".zip");
    writeFileSync(src, buildZip([{ name: "x" + i + ".txt", data: Buffer.alloc(100 + (i % 7), 0x62) }]));
    const at = statSync(files[i]).mtime;
    utimesSync(src, at, at);
    execFileSync("cp", ["-p", src, files[i]]);
    replaced.add(i);
  }

  let h3 = 0;
  let reparsed = 0;
  let wrong = 0;
  t = process.hrtime.bigint();
  for (let i = 0; i < assets.length; i++) {
    const r = await stageArchive(ctx(), assets[i]);
    const hit = isHit(r.note);
    if (hit) h3++; else reparsed++;
    const got = pathsOf(assets[i].id)[0];
    const expect = replaced.has(i) ? "x" + i + ".txt" : "e" + i + ".txt";
    if (got !== expect) wrong++;
  }
  const mixMs = Number(process.hrtime.bigint() - t) / 1e6;

  console.log(JSON.stringify({
    files: N,
    cold: { parsed: N, hits: h1, totalMs: +coldMs.toFixed(0), avgMs: +(coldMs / N).toFixed(2) },
    warm: { hits: h2, hitRatePct: +((h2 / N) * 100).toFixed(1), totalMs: +warmMs.toFixed(0), avgMs: +(warmMs / N).toFixed(2) },
    sampleCost: { totalMs: +sampleMs.toFixed(0), avgMs: +(sampleMs / N).toFixed(2) },
    warmWithoutSampleEstimateAvgMs: +((warmMs - sampleMs) / N).toFixed(2),
    replacedMix: { replaced: replaced.size, hits: h3, reparsed, wrongDirs: wrong, totalMs: +mixMs.toFixed(0), avgMs: +(mixMs / N).toFixed(2) },
    beforeReference: "替换前实现（AUD-03 S3b 实测）：同样混合会 500/500 命中、其中 50 条目录错误；after 见 replacedMix（wrongDirs 必须 0）",
  }, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--bench")) { await bench(); return; }
  // 1) 跨资产：同 size+mtime、不同路径、不同内容
  {
    const { a, b } = twins("s1");
    const ra = register(a);
    const rb = register(b);
    const r1 = await stageArchive(ctx(), ra);
    const r2 = await stageArchive(ctx(), rb);
    record("S1", "跨资产同 size+mtime 不同内容", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "A=" + JSON.stringify(pathsOf(ra.id)) + " B=" + JSON.stringify(pathsOf(rb.id)) + " note2=" + String(r2.note).slice(0, 40));
  }

  // 2) rename 替换：同路径、新 inode、同 size、同 mtime
  {
    const { a, b } = twins("s2");
    const victim = join(work, "s2-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const ra = register(victim);
    await stageArchive(ctx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    renameSync(b, victim);
    const inoAfter = Number(statSync(victim).ino);
    const r2 = await stageArchive(ctx(), ra);
    record("S2", "rename 替换（新 inode，同 size+mtime）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "ino " + inoBefore + "->" + inoAfter + " entries=" + JSON.stringify(pathsOf(ra.id)));
  }

  // 3) cp -p 覆盖：同 inode、同 size、同 mtime      ← 残差重点
  {
    const { a, b } = twins("s3");
    const victim = join(work, "s3-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const ra = register(victim);
    await stageArchive(ctx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    cpSync(b, victim, { preserveTimestamps: true });
    const inoAfter = Number(statSync(victim).ino);
    const truth = (await listArchive(victim)).entries.map((e) => e.path);
    const r2 = await stageArchive(ctx(), ra);
    record("S3", "cpSync 覆盖（Node 实现，会用新 inode 替换）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "ino " + inoBefore + "->" + inoAfter + " 磁盘真实=" + JSON.stringify(truth) + " 缓存=" + JSON.stringify(pathsOf(ra.id)));
  }

  // 3b) GNU cp -p 覆盖：就地截断写，inode 不变
  {
    const { a, b } = twins("s3b");
    const victim = join(work, "s3b-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const ra = register(victim);
    await stageArchive(ctx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    execFileSync("cp", ["-p", b, victim]);
    const live = liveOf(victim);
    const truth = (await listArchive(victim)).entries.map((e) => e.path);
    const r2 = await stageArchive(ctx(), ra);
    record("S3b", "GNU cp -p 覆盖（就地写，同 inode/size/mtime）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "ino " + inoBefore + "->" + Number(live.ino) + " size=" + live.size + " 磁盘真实=" + JSON.stringify(truth) + " 缓存=" + JSON.stringify(pathsOf(ra.id)));
  }

  // 4) 原地写 + 回写 mtime（同 inode、同 size、同 mtime）
  {
    const { a, b } = twins("s4");
    const victim = join(work, "s4-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const ra = register(victim);
    await stageArchive(ctx(), ra);
    const bytes = (await import("node:fs")).readFileSync(b);
    writeFileSync(victim, bytes);
    utimesSync(victim, at, at);
    const r2 = await stageArchive(ctx(), ra);
    record("S4", "原地写 + 回写 mtime（同 inode）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "entries=" + JSON.stringify(pathsOf(ra.id)));
  }

  // 5) 陈旧 sha 窗口：同 size+mtime 替换后，scan 不改 sha → 强身份仍成立
  {
    const { a, b } = twins("s5");
    const victim = join(work, "s5-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const fakeSha = "9".repeat(64);
    const ra = register(victim, { sha: fakeSha });
    await stageArchive(ctx(), ra);
    cpSync(b, victim, { preserveTimestamps: true });
    const row = repo.getAsset(ra.id)!;
    const live = liveOf(victim);
    const id = contentIdentity(row, live);
    const r2 = await stageArchive(ctx(), row);
    record("S5", "陈旧 sha 窗口（同 size+mtime 替换，scan 不重置）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "identity=" + id.identity.slice(0, 24) + " weak=" + id.weak + " 真实内容应为 b1.txt，缓存=" + JSON.stringify(pathsOf(ra.id)));
  }

  // 6) 强键污染：条目被清后，新内容被写进旧 sha 的键
  {
    const { a, b } = twins("s6");
    const victim = join(work, "s6-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const fakeSha = "8".repeat(64);
    const ra = register(victim, { sha: fakeSha });
    await stageArchive(ctx(), ra);
    const sampleBefore = await sampleOf(victim);
    const keyBefore = keyFor("sha256:" + fakeSha, sampleBefore);
    cpSync(b, victim, { preserveTimestamps: true });
    cache.drop(keyBefore, undefined, "test-gc"); // 模拟旧键条目被 GC：若实现只按 sha 建键，新内容就会写进旧键
    const r2 = await stageArchive(ctx(), repo.getAsset(ra.id)!);
    // FIX-05 后：新内容进"旧 sha + 新采样"的独立键，旧 sha + 旧采样的键不会被覆盖
    const sampleAfter = await sampleOf(victim);
    assertSampleDiff(sampleBefore, sampleAfter);
    const keyNow = keyFor("sha256:" + fakeSha, sampleAfter);
    const newEntry = await cache.get<any>("archive-listing", keyNow);
    const oldEntry = await cache.get<any>("archive-listing", keyBefore);
    const stored = Array.isArray(newEntry?.entries) ? newEntry.entries.map((e: any) => e.path) : null;
    const stale = Array.isArray(oldEntry?.entries) ? oldEntry.entries.map((e: any) => e.path) : null;
    record("S6", "强键污染（新内容写进旧 sha 键）", "MISS", oldEntry && stale?.[0] === "b1.txt" ? "HIT" : "MISS",
      "reparsed=" + !isHit(r2.note) + " 新键内容=" + JSON.stringify(stored) + " 旧键内容=" + JSON.stringify(stale) + "（旧键应保持 a1.txt 或不存在）");

    // 6b) 污染后果：另一个"真的拥有旧 sha 内容"的资产会读到 b1.txt（跨资产错误）
    const oldContent = join(work, "s6b-old-content.zip");
    writeFileSync(oldContent, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const rc = register(oldContent, { sha: fakeSha });
    const r3 = await stageArchive(ctx(), rc);
    const got = pathsOf(rc.id);
    record("S6b", "强键污染的跨资产后果（旧 sha 内容读到别人的目录）", "MISS", got[0] === "b1.txt" ? "HIT" : "MISS",
      "命中=" + isHit(r3.note) + " 该资产真实条目= [\"a1.txt\"] 实际写入=" + JSON.stringify(got));
  }

  // 7) 强身份跨路径同内容复用（正确性对照）
  {
    const bytes = buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]);
    const c1 = join(work, "s7-copy1.zip");
    const c2 = join(work, "s7-copy2.zip");
    writeFileSync(c1, bytes);
    writeFileSync(c2, bytes);
    const sha = "7".repeat(64);
    const r1 = register(c1, { sha });
    const r2 = register(c2, { sha });
    const before = repo.listCacheEntries("archive-listing").length;
    await stageArchive(ctx(), r1);
    const r = await stageArchive(ctx(), r2);
    const after = repo.listCacheEntries("archive-listing").length;
    record("S7", "强身份同内容跨路径复用（应命中且只写一条）", "HIT", isHit(r.note) ? "HIT" : "MISS",
      "entries=" + JSON.stringify(pathsOf(r2.id)) + " 新增缓存条目=" + (after - before));
  }

  // 8) ino/dev 退化（模拟 Windows ino=0/dev=0）：同 asset 同路径、同 size/mtime、内容不同 → 键无法区分
  {
    const { a, b } = twins("s8");
    const ra = register(a);
    const live = liveOf(a);
    const winLiveA = { size: live.size, mtimeMs: live.mtimeMs, ino: 0, dev: 0 };
    const winLiveB = { size: live.size, mtimeMs: live.mtimeMs, ino: 0, dev: 0 }; // 内容换成 B 后 ino 不可用
    const linuxA = contentIdentity(ra, live).identity;
    const linuxB = contentIdentity(ra, { ...live, ino: live.ino + 1 }).identity;
    const winA = contentIdentity(ra, winLiveA).identity;
    const winB = contentIdentity(ra, winLiveB).identity;
    const linuxDistinguishes = linuxA !== linuxB;
    const winDistinguishes = winA !== winB;
    // FIX-05 后：即使 identity 不可区分，sample 参与 cacheKey.extra 仍能让键不同
    const keyWinA = keyFor(winA, await sampleOf(a));
    const keyWinB = keyFor(winB, await sampleOf(b));
    record("S8", "ino/dev 退化（Windows ino=0）：identity 不可区分，但 sample 让键不同", "MISS", keyWinA === keyWinB ? "HIT" : "MISS",
      "linux identity 区分=" + linuxDistinguishes + "; win identity 区分=" + winDistinguishes + " → 但 sample 键区分=" + (keyWinA !== keyWinB));
  }

  // 9) inode 复用探测（unlink 后重建）
  {
    const f = join(work, "s9-reuse.bin");
    const bytes = Buffer.alloc(2048, 3);
    const inos: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (i > 0) { try { unlinkSync(f); } catch { /* ignore */ } }
      writeFileSync(f, bytes);
      inos.push(Number(statSync(f).ino));
    }
    const dup = inos.length - new Set(inos).size;
    record("S9", "inode 复用（tmpfs：unlink 后重建，同 size）", "MISS", dup > 0 ? "HIT" : "MISS",
      "inos=" + JSON.stringify(inos) + " 复用次数=" + dup + "（复用>0 时弱键无法区分删后重建）");

    // 9b) 同样探测在 ext2/3 文件系统（工作区根，非仓库内）上的行为
    const extRoot = mkdtempSync("/root/Code/.aud03-fs-");
    try {
      const f2 = join(extRoot, "reuse.bin");
      const inos2: number[] = [];
      for (let i = 0; i < 8; i++) {
        if (i > 0) { try { unlinkSync(f2); } catch { /* ignore */ } }
        writeFileSync(f2, bytes);
        inos2.push(Number(statSync(f2).ino));
      }
      const dup2 = inos2.length - new Set(inos2).size;
      // 端到端：同路径、同 size+mtime 的"删后重建"（ino 可能被复用）→ sample 仍让键不同 → 必须 MISS
      const victim = join(work, "s9b-victim.zip");
      writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
      const at = new Date("2026-05-06T07:08:09.100Z");
      utimesSync(victim, at, at);
      const ra = register(victim);
      await stageArchive(ctx(), ra);
      const inoBefore = Number(statSync(victim).ino);
      unlinkSync(victim);
      writeFileSync(victim, buildZip([{ name: "b1.txt", data: Buffer.alloc(100, 0x62) }]));
      utimesSync(victim, at, at);
      const inoAfter = Number(statSync(victim).ino);
      const r2 = await stageArchive(ctx(), ra);
      record("S9b", "inode 复用（ext2/3：删后重建，同 size+mtime）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
        "ino 复用=" + (dup2 > 0) + " (" + inoBefore + "->" + inoAfter + ") 采样让键不同 → entries=" + JSON.stringify(pathsOf(ra.id)));
    } finally {
      try { rmSync(extRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // 10) scan 重置 sha 的窗口：同 size+mtime 替换 → scan 视为 unchanged → sha 不重置 → 强键继续命中旧目录
  {
    const { a, b } = twins("s10");
    void a;
    const victim = join(work, "s10-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const fakeSha = "6".repeat(64);
    const ra = register(victim, { sha: fakeSha });
    await stageArchive(ctx(), ra);
    execFileSync("cp", ["-p", b, victim]); // 同 inode/size/mtime 替换
    const st = statSync(victim);
    // 模拟一次扫描：scan 的 unchanged 判定只会把 size/mtime 交给 upsertAsset
    const up = repo.upsertAsset({ item_id: itemId, kind: "archive", container: "zip", path: victim, path_norm: victim.toLowerCase(), root_id: rootId, size: st.size, mtime: st.mtime.toISOString(), discovered_by: "scan" });
    const row = repo.getAsset(up.asset.id)!;
    const shaReset = row.sha256 === null || row.sha256_state !== "ok";
    const r2 = await stageArchive(ctx(), row);
    record("S10", "scan 重置窗口（同 size+mtime → scan unchanged，sha 保留）", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "sha被重置=" + shaReset + " sha_state=" + row.sha256_state + " entries=" + JSON.stringify(pathsOf(row.id)));
  }

  // 11) 对照：metadata 变化（mtime 变）→ scan 重置 sha → 强键失效
  {
    const { b } = twins("s11");
    const victim = join(work, "s11-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    const ra = register(victim, { sha: "5".repeat(64) });
    await stageArchive(ctx(), ra);
    const later = new Date(statSync(victim).mtimeMs + 5000);
    utimesSync(victim, later, later);
    const st = statSync(victim);
    const up = repo.upsertAsset({ item_id: itemId, kind: "archive", container: "zip", path: victim, path_norm: victim.toLowerCase(), root_id: rootId, size: st.size, mtime: st.mtime.toISOString(), discovered_by: "scan" });
    const row = repo.getAsset(up.asset.id)!;
    const shaReset = row.sha256 === null && row.sha256_state === "pending";
    const r2 = await stageArchive(ctx(), row);
    record("S11", "对照：mtime 变 → scan 重置 sha → 强键失效", "MISS", isHit(r2.note) ? "HIT" : "MISS",
      "sha被重置=" + shaReset + " sha_state=" + row.sha256_state + " entries=" + JSON.stringify(pathsOf(row.id)));
  }

  // 12) ctime 探针：若把 ctime 纳入弱键，能挡住哪些替换？（只测量，不改实现）
  {
    // 用 ns 精度（ms 精度在同一毫秒内会掩盖 ctime 变化）
    const cst = (p: string) => { const s = statSync(p, { bigint: true }); return { ctime: String(s.ctimeNs), mtime: String(s.mtimeNs), ino: String(s.ino) }; };
    const { a, b } = twins("s12");
    const at = statSync(b).mtime;

    const p1 = join(work, "s12-cp.zip");
    writeFileSync(p1, readFileSync(a));
    utimesSync(p1, at, at);
    const c1 = cst(p1);
    execFileSync("cp", ["-p", b, p1]);
    const c2 = cst(p1);
    probes.push("S12a cp -p 覆盖：ctime 变=" + (c1.ctime !== c2.ctime) + ", mtime 变=" + (c1.mtime !== c2.mtime) + ", ino 变=" + (c1.ino !== c2.ino));

    const p2 = join(work, "s12-write.zip");
    writeFileSync(p2, readFileSync(a));
    utimesSync(p2, at, at);
    const c3 = cst(p2);
    writeFileSync(p2, readFileSync(b));
    utimesSync(p2, at, at);
    const c4 = cst(p2);
    probes.push("S12b 原地写+回写 mtime：ctime 变=" + (c3.ctime !== c4.ctime) + ", mtime 变=" + (c3.mtime !== c4.mtime) + ", ino 变=" + (c3.ino !== c4.ino));

    const p3 = join(work, "s12-recreate.zip");
    writeFileSync(p3, readFileSync(a));
    utimesSync(p3, at, at);
    const c5 = cst(p3);
    unlinkSync(p3);
    writeFileSync(p3, readFileSync(b));
    utimesSync(p3, at, at);
    const c6 = cst(p3);
    probes.push("S12c 删后重建：ctime 变=" + (c5.ctime !== c6.ctime) + ", mtime 变=" + (c5.mtime !== c6.mtime) + ", ino 变=" + (c5.ino !== c6.ino) + "（同 size）");
  }

  // 输出
  const json = process.argv.includes("--json");
  if (json) { console.log(JSON.stringify(rows, null, 2)); }
  else {
    console.log("id   期望  实测  判定  场景 / 证据");
    for (const r of rows) console.log([r.id.padEnd(4), r.expected.padEnd(5), r.observed.padEnd(5), r.verdict.padEnd(5), r.scenario, "|", r.detail].join(" "));
    const vuln = rows.filter((r) => r.verdict === "VULN");
    console.log("\n汇总: " + rows.length + " 条, SAFE=" + (rows.length - vuln.length) + ", VULN=" + vuln.length);
    if (probes.length) { console.log("\nctime 探针（若把 ctime 纳入弱键/扫描判定，能挡住哪些替换）："); for (const p of probes) console.log("  - " + p); }
    console.log("\n文件系统: work=" + work + " cache=" + cacheRoot + "; 平台=" + process.platform);
  }
}

try { await main(); } finally {
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  t.close();
}
