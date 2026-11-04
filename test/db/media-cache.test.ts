/**
 * media-cache：托管缩略图缓存预览/确认清理（TDD，fix-r1 扩展）。
 * 只操作 tmp 合成目录 + tmp DB；不触生产。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, symlinkSync, linkSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openTempDb, addItem, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { MediaStore } from "../../apps/server/src/services/media";
import { scanMediaCache, previewMediaCache, cleanupMediaCache } from "../../apps/server/src/services/media-cache";

const OLD = Date.now() - 25 * 3600 * 1000;
const touchOld = (p: string) => utimesSync(p, new Date(OLD), new Date(OLD));
const mkFile = (dir: string, name: string, bytes = "x") => { const p = join(dir, name); writeFileSync(p, bytes); touchOld(p); return p; };
const sha16 = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

let t: TempDb; let repo: Repo; let mediaRoot: string; let media: MediaStore;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); mediaRoot = mkdtempSync(join(tmpdir(), "av-mc-")); media = new MediaStore(mediaRoot); });
afterEach(() => { t.close(); rmSync(mediaRoot, { recursive: true, force: true }); });

function setup() {
  const d1 = join(mediaRoot, "1"); mkdirSync(d1, { recursive: true });
  const orphan = mkFile(d1, "aaaaaaaaaaaaaaaa.jpg");
  const referenced = mkFile(d1, "bbbbbbbbbbbbbbbb.jpg");
  const recent = join(d1, "cccccccccccccccc.jpg"); writeFileSync(recent, "x");
  const unknownName = mkFile(d1, "not-a-sha.jpg");
  const unknownExt = mkFile(d1, "dddddddddddddddd.exe");
  const thumb = mkFile(d1, "eeeeeeeeeeeeeeee.thumb.webp");
  const item = addItem(t.db, { title: "i" });
  repo.addImage(item, { role: "cover", origin: "booth", file_path: referenced, thumb_path: thumb });
  return { d1, orphan, referenced, recent, unknownName, unknownExt, thumb, item };
}

describe("media-cache scan", () => {
  test("只把 24h+ 且无引用的托管图片列为候选", () => {
    const s = setup();
    const r = scanMediaCache(mediaRoot, repo);
    assert.deepEqual(r.candidates.map((c) => c.path), [s.orphan]);
    assert.equal(r.protected.referenced >= 2, true);
    assert.equal(r.protected.recent, 1);
    assert.equal(r.protected.unknown >= 2, true);
  });
  test("跨目录/回收站引用按实际路径保护", () => {
    const s = setup();
    const d2 = join(mediaRoot, "2"); mkdirSync(d2, { recursive: true });
    const cross = mkFile(d2, "ffffffffffffffff.jpg");
    const item2 = addItem(t.db, { title: "j" });
    repo.addImage(item2, { role: "gallery", origin: "booth", file_path: cross });
    t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(item2);
    const r = scanMediaCache(mediaRoot, repo);
    assert.equal(r.candidates.some((c) => c.path === cross), false);
  });
  test("symlink 与未知目录保留", () => {
    const s = setup();
    const link = join(s.d1, "1111111111111111.jpg");
    symlinkSync(s.orphan, link);
    const weird = join(mediaRoot, "not-numeric"); mkdirSync(weird, { recursive: true });
    mkFile(weird, "2222222222222222.jpg");
    const r = scanMediaCache(mediaRoot, repo);
    assert.equal(r.candidates.some((c) => c.path === link), false);
    assert.equal(r.candidates.some((c) => c.path.includes("not-numeric")), false);
  });
  test("root symlink → 0 候选 + blockedReason；cleanup 闭锁", async () => {
    const real = mkdtempSync(join(tmpdir(), "av-mc-real-"));
    const linkRoot = join(tmpdir(), "av-mc-link-" + Date.now());
    symlinkSync(real, linkRoot);
    const p = previewMediaCache(linkRoot, repo);
    assert.equal(p.candidates.length, 0);
    assert.equal(p.blockedReason, "ROOT_LINK_UNSUPPORTED");
    const r = await cleanupMediaCache(linkRoot, repo, { token: p.token, confirm: true });
    assert.equal(r.deleted, 0);
    rmSync(linkRoot, { force: true }); rmSync(real, { recursive: true, force: true });
  });
  test("祖先 symlink → blocked", () => {
    const realParent = mkdtempSync(join(tmpdir(), "av-mc-parent-"));
    const linkParent = join(tmpdir(), "av-mc-plink-" + Date.now());
    symlinkSync(realParent, linkParent);
    const root = join(linkParent, "media");
    mkdirSync(root, { recursive: true });
    const p = previewMediaCache(root, repo);
    assert.equal(p.blockedReason, "ROOT_LINK_UNSUPPORTED");
    rmSync(linkParent, { force: true }); rmSync(realParent, { recursive: true, force: true });
  });
});

describe("preview/cleanup token", () => {
  test("无 confirm / 缺 token / 重复 token / 过期 token 均拒绝", async () => {
    const s = setup();
    const p = previewMediaCache(mediaRoot, repo);
    assert.throws(() => cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: false }), /confirm/);
    assert.throws(() => cleanupMediaCache(mediaRoot, repo, { token: "nope", confirm: true }), /token/);
    const r1 = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
    assert.equal(r1.deleted, 1);
    assert.throws(() => cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true }), /token/);
    const p2 = previewMediaCache(mediaRoot, repo, { now: Date.now() });
    assert.throws(() => cleanupMediaCache(mediaRoot, repo, { token: p2.token, confirm: true, now: Date.now() + 11 * 60 * 1000 }), /expired/);
  });
  test("预览后新增引用 → 跳过不删", async () => {
    const s = setup();
    const p = previewMediaCache(mediaRoot, repo);
    const item3 = addItem(t.db, { title: "k" });
    repo.addImage(item3, { role: "cover", origin: "user", file_path: s.orphan });
    const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
    assert.equal(r.deleted, 0);
    assert.equal(existsSync(s.orphan), true);
  });
  test("预览后文件被替换（mtime/size 变）→ 跳过", async () => {
    const s = setup();
    const p = previewMediaCache(mediaRoot, repo);
    writeFileSync(s.orphan, "changed");
    const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
    assert.equal(r.deleted, 0);
    assert.equal(existsSync(s.orphan), true);
  });
});

describe("写入互斥与复用 mtime", () => {
  test("saveImage 复用旧文件时刷新 mtime，cleanup 跳过", async () => {
    const bytes = Buffer.from("same-content");
    const saved = await media.saveImage(1, bytes, "jpg");
    utimesSync(saved.filePath, new Date(OLD), new Date(OLD));
    assert.equal(scanMediaCache(mediaRoot, repo).candidates.some((c) => c.path === saved.filePath), true);
    await media.saveImage(1, bytes, "jpg");
    assert.equal(scanMediaCache(mediaRoot, repo).candidates.some((c) => c.path === saved.filePath), false);
  });
  test("真实交错：25h orphan 在候选 → 并发 saveImage 复用 + cleanup → deleted0/文件在/mtime 刷新/DB 未附图", async () => {
    const bytes = Buffer.from("interleave-real");
    const saved = await media.saveImage(1, bytes, "jpg");
    utimesSync(saved.filePath, new Date(OLD), new Date(OLD));
    const p = previewMediaCache(mediaRoot, repo);
    assert.equal(p.candidates.some((c) => c.path === saved.filePath), true, "orphan 必须在候选");
    const before = statSync(saved.filePath).mtimeMs;
    const [saved2, cleaned] = await Promise.all([media.saveImage(1, bytes, "jpg"), cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true })]);
    assert.equal(cleaned.deleted, 0);
    assert.equal(existsSync(saved.filePath), true);
    assert.ok(statSync(saved.filePath).mtimeMs > before, "mtime 必须刷新");
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM item_images WHERE file_path=?").get(saved.filePath) as { c: number }).c, 0, "DB 尚未附图");
  });
  test("正对照：普通旧 orphan 真能删（shared lock 不是只 cleanup 自锁）", async () => {
    const s = setup();
    const p = previewMediaCache(mediaRoot, repo);
    const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
    assert.equal(r.deleted, 1);
    assert.equal(existsSync(s.orphan), false);
  });
  test("hardlink 复用拒绝且外源 mtime 不变", async () => {
    const bytes = Buffer.from("hardlink-content");
    const ext = mkdtempSync(join(tmpdir(), "av-mc-ext-"));
    const external = join(ext, "orig.jpg"); writeFileSync(external, bytes);
    const before = statSync(external).mtimeMs;
    const d1 = join(mediaRoot, "1"); mkdirSync(d1, { recursive: true });
    linkSync(external, join(d1, sha16(bytes) + ".jpg"));
    await assert.rejects(() => media.saveImage(1, bytes, "jpg"), /hardlink|refused/);
    assert.equal(statSync(external).mtimeMs, before, "外源 mtime 不得变");
    rmSync(ext, { recursive: true, force: true });
  });
  test("symlink 复用拒绝且外源 mtime 不变", async () => {
    const bytes = Buffer.from("symlink-content");
    const ext = mkdtempSync(join(tmpdir(), "av-mc-ext2-"));
    const external = join(ext, "orig.jpg"); writeFileSync(external, bytes);
    const before = statSync(external).mtimeMs;
    const d1 = join(mediaRoot, "1"); mkdirSync(d1, { recursive: true });
    symlinkSync(external, join(d1, sha16(bytes) + ".jpg"));
    await assert.rejects(() => media.saveImage(1, bytes, "jpg"), /symlink|refused|leaf link/);
    assert.equal(statSync(external).mtimeMs, before, "外源 mtime 不得变");
    rmSync(ext, { recursive: true, force: true });
  });
});

describe("fix-r2 配置 dataDir 祖先链接", () => {
  test("a 普通目录 save/reuse 正常", async () => {
    const bytes = Buffer.from("plain-dir");
    const s1 = await media.saveImage(1, bytes, "jpg");
    assert.equal(existsSync(s1.filePath), true);
    const s2 = await media.saveImage(1, bytes, "jpg");
    assert.equal(s2.filePath, s1.filePath);
  });
  test("b parent dataDir 合法 symlink + media 普通目录 → 新存/复用成功，preview 仍 blocked/0", async () => {
    const realParent = mkdtempSync(join(tmpdir(), "av-r2-real-"));
    const linkParent = join(tmpdir(), "av-r2-link-" + Date.now());
    symlinkSync(realParent, linkParent);
    const root = join(linkParent, "media");
    mkdirSync(root, { recursive: true });
    const m = new MediaStore(root);
    const bytes = Buffer.from("symlink-parent-ok");
    const s1 = await m.saveImage(1, bytes, "jpg");
    const name = s1.filePath.split("/").pop()!;
    assert.equal(existsSync(join(realParent, "media", "1", name)), true, "物理 root 下应有文件");
    const before = statSync(s1.filePath).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    const s2 = await m.saveImage(1, bytes, "jpg");
    assert.equal(s2.filePath, s1.filePath);
    assert.ok(statSync(s1.filePath).mtimeMs > before, "复用应刷新 mtime");
    const p = previewMediaCache(root, repo);
    assert.equal(p.candidates.length, 0);
    assert.equal(p.blockedReason, "ROOT_LINK_UNSUPPORTED");
    rmSync(linkParent, { force: true }); rmSync(realParent, { recursive: true, force: true });
  });
  test("c mediaRoot 自身 link 与数字 itemdir link 均拒，外源 hash/mtime 不变", async () => {
    const real = mkdtempSync(join(tmpdir(), "av-r2-root-"));
    const linkRoot = join(tmpdir(), "av-r2-rootlink-" + Date.now());
    symlinkSync(real, linkRoot);
    const m1 = new MediaStore(linkRoot);
    await assert.rejects(() => m1.saveImage(1, Buffer.from("x"), "jpg"), /root link/);
    const ext = mkdtempSync(join(tmpdir(), "av-r2-ext-"));
    const extFile = join(ext, "keep.jpg"); writeFileSync(extFile, "keep");
    const beforeHash = createHash("sha256").update(readFileSync(extFile)).digest("hex");
    const beforeM = statSync(extFile).mtimeMs;
    const root2 = mkdtempSync(join(tmpdir(), "av-r2-root2-"));
    symlinkSync(ext, join(root2, "1"));
    const m2 = new MediaStore(root2);
    await assert.rejects(() => m2.saveImage(1, Buffer.from("y"), "jpg"), /item dir link/);
    assert.equal(createHash("sha256").update(readFileSync(extFile)).digest("hex"), beforeHash, "外源内容不变");
    assert.equal(statSync(extFile).mtimeMs, beforeM, "外源 mtime 不变");
    rmSync(linkRoot, { force: true }); rmSync(real, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true });
  });
});

describe("fix-r3 Windows 引用 identity", () => {
  const win = { platform: "win32" as const };
  const aliasOf = (p: string) => p.replace(/[a-z]/g, (c) => c.toUpperCase()).replaceAll("/", "\\").replace(/^\\\\/, "\\");
  function addRef(dbPath: string, opts: { thumb?: boolean; trashed?: boolean } = {}) {
    const item = addItem(t.db, { title: "r" });
    repo.addImage(item, { role: "cover", origin: "booth", file_path: opts.thumb ? null : dbPath, thumb_path: opts.thumb ? dbPath : null });
    if (opts.trashed) t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(item);
    return item;
  }
  test("win32 同物理路径 drive/dir 大小写 + 正反斜杠 → protected", () => {
    const s = setup();
    const file = mkFile(s.d1, "3333333333333333.jpg");
    addRef(aliasOf(file));
    const r = scanMediaCache(mediaRoot, repo, win);
    assert.ok(r.protected.referenced >= 1);
    assert.equal(r.candidates.some((c) => c.path === file), false);
  });
  test("win32 thumb 引用别名 → protected", () => {
    const s = setup();
    const file = mkFile(s.d1, "4444444444444444.jpg");
    addRef(aliasOf(file), { thumb: true });
    const r = scanMediaCache(mediaRoot, repo, win);
    assert.ok(r.protected.referenced >= 1);
    assert.equal(r.candidates.some((c) => c.path === file), false);
  });
  test("win32 trashed 别名 → protected", () => {
    const s = setup();
    const file = mkFile(s.d1, "5555555555555555.jpg");
    addRef(aliasOf(file), { trashed: true });
    const r = scanMediaCache(mediaRoot, repo, win);
    assert.ok(r.protected.referenced >= 1);
    assert.equal(r.candidates.some((c) => c.path === file), false);
  });
  test("win32 crossitem 别名 → protected", () => {
    const s = setup();
    const file = mkFile(s.d1, "6666666666666666.jpg");
    addRef(file); addRef(aliasOf(file));
    const r = scanMediaCache(mediaRoot, repo, win);
    assert.ok(r.protected.referenced >= 1);
    assert.equal(r.candidates.some((c) => c.path === file), false);
  });
  test("win32 preview 后 attach 新别名 → cleanup 即时刷新跳过", async () => {
    const s = setup();
    const file = mkFile(s.d1, "7777777777777777.jpg");
    const p = previewMediaCache(mediaRoot, repo, win);
    assert.equal(p.candidates.some((c) => c.path === file), true);
    addRef(aliasOf(file));
    const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true, platform: "win32" });
    assert.equal(existsSync(file), true);
    assert.ok(r.skipped >= 1);
  });
  test("POSIX 正对照：不同 case 是不同路径，普通 orphan 真能删", async () => {
    const s = setup();
    const file = mkFile(s.d1, "8888888888888888.jpg");
    addRef(aliasOf(file));
    const p = previewMediaCache(mediaRoot, repo);
    assert.equal(p.candidates.some((c) => c.path === file), true);
    const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
    assert.equal(existsSync(file), false);
    assert.ok(r.deleted >= 1);
  });
});

describe("fix-r3 真实默认分支（process.platform 覆盖）", () => {
  const aliasOf = (p: string) => p.replace(/[a-z]/g, (c) => c.toUpperCase()).replaceAll("/", "\\").replace(/^\\\\/, "\\");
  function addRef(dbPath: string) { const item = addItem(t.db, { title: "r" }); repo.addImage(item, { role: "cover", origin: "booth", file_path: dbPath }); }
  test("win32 覆盖下 scan+cleanup 均走真实 normalize 分支，别名 protected（finally 恢复 descriptor）", async () => {
    const s = setup();
    const file = mkFile(s.d1, "9999999999999999.jpg");
    const desc = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const p = previewMediaCache(mediaRoot, repo);
      assert.equal(p.candidates.some((c) => c.path === file), true);
      addRef(aliasOf(file));
      const r = await cleanupMediaCache(mediaRoot, repo, { token: p.token, confirm: true });
      assert.equal(existsSync(file), true);
      assert.ok(r.skipped >= 1);
    } finally {
      Object.defineProperty(process, "platform", desc);
    }
  });
});