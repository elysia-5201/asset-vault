/** BOOTH 导入反馈 imageStats（task85 A 域） */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openTempDb, addItem, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { MediaStore } from "../../apps/server/src/services/media";
import { importBoothUrl } from "../../apps/server/src/services/booth";

let t: TempDb; let repo: Repo; let media: MediaStore; let mediaDir: string;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); addRoot(t.db, "/lib"); mediaDir = mkdtempSync(join(tmpdir(), "av-booth-stats-")); media = new MediaStore(mediaDir); });
afterEach(() => { t.close(); rmSync(mediaDir, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const coverOf = (id: number) => (t.db.prepare("SELECT cover_image_id c FROM items WHERE id=?").get(id) as any).c as number | null;

function client(urls: string[], bytesFor: (u: string) => Buffer | null) {
  return {
    fetchItem: async () => ({ title: "T", url: "https://booth.pm/ja/items/12345", priceText: "", priceYen: 0, publishedAt: null, isAdult: false, category: null, description: "", tags: [], shop: { name: "s", subdomain: "s" }, variations: [], images: urls.map((u) => ({ original: u, resized: "" })) }),
    fetchImage: async (u: string) => { const b = bytesFor(u); if (!b) throw new Error("fail"); return { bytes: b, contentType: "image/jpeg" }; },
  } as any;
}

describe("imageStats 定义", () => {
  test("重复 URL 只处理一次：requested=去重 URL 数", async () => {
    const item = addItem(t.db, { title: "local" });
    const c = client(["https://booth.pximg.net/a", "https://booth.pximg.net/a"], () => Buffer.from("a"));
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.imageStats.requested, 1);
    assert.equal(out.imageStats.downloaded, 1);
    assert.equal(out.imageStats.added, 1);
    assert.equal(out.images, 1);
  });

  test("不同 URL 同内容：added=1, duplicates=1, images 唯一=1", async () => {
    const item = addItem(t.db, { title: "local" });
    const c = client(["https://booth.pximg.net/a", "https://booth.pximg.net/b"], () => Buffer.from("same"));
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.deepEqual(out.imageStats, { requested: 2, downloaded: 2, added: 1, reused: 0, duplicates: 1, failed: 0 });
    assert.equal(out.images, 1, "images 必须是唯一行数，不是 addedIds.length");
  });

  test("已存在同 SHA 行：reused=1，不新增", async () => {
    const item = addItem(t.db, { title: "local" });
    repo.addImage(item, { role: "gallery", origin: "booth", sha256: sha(Buffer.from("x")) });
    const c = client(["https://booth.pximg.net/x"], () => Buffer.from("x"));
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.imageStats.reused, 1);
    assert.equal(out.imageStats.added, 0);
    assert.equal(out.imageStats.duplicates, 0);
  });

  test("部分失败：failed=requested-downloaded", async () => {
    const item = addItem(t.db, { title: "local" });
    const c = client(["https://booth.pximg.net/a", "https://booth.pximg.net/b"], (u) => (u.endsWith("/a") ? Buffer.from("a") : null));
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.imageStats.requested, 2);
    assert.equal(out.imageStats.downloaded, 1);
    assert.equal(out.imageStats.failed, 1);
  });

  test("全部失败：不删 archive、不改 cover、stats 全 0 下载", async () => {
    const item = addItem(t.db, { title: "local" });
    const a = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    const c = client(["https://booth.pximg.net/a"], () => null);
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.deepEqual(out.imageStats, { requested: 1, downloaded: 0, added: 0, reused: 0, duplicates: 0, failed: 1 });
    assert.equal(coverOf(item), a);
  });

  test("事务失败：抛错且不返回成功统计，旧 cover 保留", async () => {
    const item = addItem(t.db, { title: "local" });
    const a = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    t.db.exec("CREATE TRIGGER fail_cover_stats BEFORE UPDATE OF cover_image_id ON items BEGIN SELECT RAISE(ABORT,'boom'); END;");
    const c = client(["https://booth.pximg.net/a"], () => Buffer.from("a"));
    await assert.rejects(() => importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item }), /boom/);
    assert.equal(coverOf(item), a);
    assert.equal(repo.listImages(item).filter((i) => i.origin === "booth").length, 0, "失败必须回滚新行");
    t.db.exec("DROP TRIGGER fail_cover_stats");
  });
});
