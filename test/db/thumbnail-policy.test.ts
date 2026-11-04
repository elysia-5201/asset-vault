/**
 * 缩略图规则（task78）：合并只留 target 原图；BOOTH 成功后替换 archive 默认图；
 * 已有可用 BOOTH 图的条目，扫描/索引不再补 archive 默认图。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openTempDb, addItem, addRoot, addAsset, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { MediaStore } from "../../apps/server/src/services/media";
import { importBoothUrl } from "../../apps/server/src/services/booth";
import { stageThumbs } from "../../apps/server/src/services/pipeline/stages";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { buildZip } from "../../packages/core/test/content/fixtures";

let t: TempDb; let repo: Repo; let media: MediaStore; let mediaDir: string; let rootId: number;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib");
  mediaDir = mkdtempSync(join(tmpdir(), "av-thumb-"));
  media = new MediaStore(mediaDir);
});
afterEach(() => { t.close(); rmSync(mediaDir, { recursive: true, force: true }); });

const coverOf = (id: number) => (t.db.prepare("SELECT cover_image_id c FROM items WHERE id=?").get(id) as any).c as number | null;
const images = (id: number) => repo.listImages(id);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function fakeClient(specs: { ok: boolean; bytes?: Buffer }[]) {
  return {
    fetchItem: async () => ({
      title: "T", url: "https://booth.pm/ja/items/12345", priceText: "", priceYen: 0, publishedAt: null, isAdult: false,
      category: null, description: "", tags: [], shop: { name: "s", subdomain: "s" }, variations: [],
      images: specs.map((_, i) => ({ original: "https://booth.pximg.net/" + i, resized: "" })),
    }),
    fetchImage: async (url: string) => {
      const i = Number(String(url).split("/").pop());
      const s = specs[i];
      if (!s || !s.ok) throw new Error("fail");
      return { bytes: s.bytes ?? Buffer.from("img" + i), contentType: "image/jpeg" };
    },
  } as any;
}

describe("mergeItems：只保留 target 原有图片", () => {
  test("target 有图 + source 有图 → target 不变，source 图留在 source", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    const tImg = repo.addImage(target, { role: "cover", origin: "booth" }).id;
    repo.addImage(source, { role: "cover", origin: "booth" });
    repo.addImage(source, { role: "gallery", origin: "booth" });
    const r = repo.mergeItems(source, target);
    assert.equal(r.movedImages, 0);
    assert.equal(images(target).length, 1);
    assert.equal(images(source).length, 2, "source 图不得迁入 target");
    assert.equal(coverOf(target), tImg);
    assert.equal((t.db.prepare("SELECT status FROM items WHERE id=?").get(source) as any).status, "trashed");
  });

  test("target 无图 + source 有图 → target 仍无图/无封面", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    repo.addImage(source, { role: "cover", origin: "booth" });
    repo.mergeItems(source, target);
    assert.equal(images(target).length, 0);
    assert.equal(coverOf(target), null);
  });

  test("资产/标签/模型关联仍合并（不弱化）", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    const assetId = addAsset(t.db, source, rootId, "/lib/a.zip");
    const av = repo.createAvatar({ name: "A", kind: "avatar" });
    repo.setItemAvatars(source, [av.id], "manual", "any", 0.9, "e");
    repo.attachTags(source, ["t1"], "manual");
    repo.mergeItems(source, target);
    assert.equal(repo.getAsset(assetId)!.item_id, target);
    assert.equal(repo.listItemAvatars(target).length, 1);
    assert.deepEqual(repo.listItemTagNames(target), ["t1"]);
  });

  test("dirty 跨条目 cover：target cover 指向 source 图，合并不崩且引用保留", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    const sImg = repo.addImage(source, { role: "cover", origin: "booth" }).id;
    t.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(sImg, target);
    repo.mergeItems(source, target);
    assert.equal(coverOf(target), sImg);
    assert.ok(repo.getImage(sImg));
  });
});

describe("BOOTH 导入：成功后替换 archive 默认图", () => {
  test("成功 ≥1：删 archive、保留 user、cover=首张 BOOTH", async () => {
    const item = addItem(t.db, { title: "local" });
    const a1 = repo.addImage(item, { role: "package_preview", origin: "archive" }).id;
    const a2 = repo.addImage(item, { role: "archive_frame", origin: "archive" }).id;
    const u = repo.addImage(item, { role: "gallery", origin: "user" }).id;
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: true }, { ok: true }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 2);
    const left = images(item);
    assert.equal(left.filter((i) => i.origin === "archive").length, 0);
    assert.equal(left.filter((i) => i.origin === "booth").length, 2);
    assert.ok(left.some((i) => i.id === u), "user 图保留");
    assert.equal(coverOf(item), left.find((i) => i.origin === "booth")!.id);
    assert.equal(repo.getImage(a1), null); assert.equal(repo.getImage(a2), null);
  });

  test("全部失败：archive 保留、cover 不变", async () => {
    const item = addItem(t.db, { title: "local" });
    const a1 = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: false }, { ok: false }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 0);
    assert.equal(images(item).length, 1);
    assert.equal(coverOf(item), a1);
  });

  test("首失败次成功：archive 删除，cover=成功那张", async () => {
    const item = addItem(t.db, { title: "local" });
    repo.addImage(item, { role: "cover", origin: "archive" });
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: false }, { ok: true }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 1);
    const left = images(item);
    assert.equal(left.filter((i) => i.origin === "archive").length, 0);
    assert.equal(left.filter((i) => i.origin === "booth").length, 1);
    assert.equal(coverOf(item), left[0]!.id);
  });

  test("重复导入同 URL：不重复、cover 稳定", async () => {
    const item = addItem(t.db, { title: "local" });
    const c = fakeClient([{ ok: true }, { ok: true }]);
    await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    const firstCover = coverOf(item);
    await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(images(item).filter((i) => i.origin === "booth").length, 2);
    assert.equal(coverOf(item), firstCover);
  });

  test("BOOTH 内容与 archive 同 SHA：转换该行，不删成空图、不唯一约束报错", async () => {
    const item = addItem(t.db, { title: "local" });
    const bytes = Buffer.from("same-bytes");
    const s = sha(bytes);
    const a = repo.addImage(item, { role: "package_preview", origin: "archive", sha256: s }).id;
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: true, bytes }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 1);
    const left = images(item);
    assert.equal(left.length, 1, "不得因去重删成空图");
    assert.equal(left[0]!.id, a, "复用同 SHA 行");
    assert.equal(left[0]!.origin, "booth");
    assert.equal(coverOf(item), a);
  });

  test("只影响目标 item，其他条目 archive 图不动", async () => {
    const item = addItem(t.db, { title: "local" });
    const other = addItem(t.db, { title: "other" });
    repo.addImage(item, { role: "cover", origin: "archive" });
    const o = repo.addImage(other, { role: "cover", origin: "archive" }).id;
    await importBoothUrl(repo, media, fakeClient([{ ok: true }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.ok(repo.getImage(o));
    assert.equal(images(other).length, 1);
  });
});

describe("stageThumbs：已有可用 BOOTH 图时不再补 archive 默认图", () => {
  function ctx() {
    return { repo, media, limits: resolveLimits({}), cache: { get: async () => null, put: async () => ({ bytes: 0 }) }, log: () => {}, signal: new AbortController().signal, progress: () => {} } as any;
  }
  function zipAsset(itemId: number) {
    const dir = mkdtempSync(join(tmpdir(), "av-thumb-zip-"));
    const p = join(dir, "a.zip");
    writeFileSync(p, buildZip([{ name: "Assets/pic.png", data: Buffer.alloc(2048, 7) }]));
    const id = addAsset(t.db, itemId, rootId, "/lib/a.zip", { path: p, container: "zip", kind: "archive", size: 2048 });
    repo.replaceArchiveEntries(id, [{ path: "Assets/pic.png", size: 2048, isDir: false }]);
    return { id, dir };
  }
  test("有 BOOTH 图 → 跳过，不新增 archive", async () => {
    const item = addItem(t.db, { title: "local" });
    repo.addImage(item, { role: "cover", origin: "booth" });
    const { id, dir } = zipAsset(item);
    try {
      await stageThumbs(ctx(), repo.getAsset(id)!);
      assert.equal(images(item).filter((i) => i.origin === "archive").length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("无 BOOTH 图 → 正常补 archive（正例对照）", async () => {
    const item = addItem(t.db, { title: "local" });
    const { id, dir } = zipAsset(item);
    try {
      await stageThumbs(ctx(), repo.getAsset(id)!);
      assert.ok(images(item).some((i) => i.origin === "archive"), "无 BOOTH 图时必须仍补 archive");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("fix-r1：user 同 SHA / 事务 / 零字节 / 跨条目 cover", () => {
  test("BOOTH 同 SHA 命中 user（source_url 空）：保留 user 来源/role，仅补 source_url 并设 cover", async () => {
    const item = addItem(t.db, { title: "local" });
    const bytes = Buffer.from("user-same");
    const s = sha(bytes);
    const u = repo.addImage(item, { role: "gallery", origin: "user", sha256: s }).id;
    repo.addImage(item, { role: "cover", origin: "archive" });
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: true, bytes }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 1);
    const row = repo.getImage(u)!;
    assert.equal(row.origin, "user", "不得把用户来源改成 booth");
    assert.equal(row.role, "gallery", "不得静默改用户 role");
    assert.ok(String(row.source_url || "").includes("booth"), "空 source_url 可补 BOOTH 地址作为来源标记");
    assert.equal(coverOf(item), u, "同图可作为封面");
    assert.equal(images(item).filter((i) => i.origin === "archive").length, 0);
  });

  test("user 同 SHA 后 stageThumbs 仍跳过 archive 补图", async () => {
    const item = addItem(t.db, { title: "local" });
    const bytes = Buffer.from("user-same-2");
    const s = sha(bytes);
    repo.addImage(item, { role: "gallery", origin: "user", sha256: s });
    await importBoothUrl(repo, media, fakeClient([{ ok: true, bytes }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    const dir = mkdtempSync(join(tmpdir(), "av-thumb-zip2-"));
    const p = join(dir, "a.zip");
    writeFileSync(p, buildZip([{ name: "Assets/pic.png", data: Buffer.alloc(2048, 7) }]));
    const id = addAsset(t.db, item, rootId, "/lib/a.zip", { path: p, container: "zip", kind: "archive", size: 2048 });
    repo.replaceArchiveEntries(id, [{ path: "Assets/pic.png", size: 2048, isDir: false }]);
    try {
      await stageThumbs({ repo, media, limits: resolveLimits({}), cache: { get: async () => null, put: async () => ({ bytes: 0 }) }, log: () => {}, signal: new AbortController().signal, progress: () => {} } as any, repo.getAsset(id)!);
      assert.equal(images(item).filter((i) => i.origin === "archive").length, 0, "user 同 SHA 也视为已有可用 BOOTH 图");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("事务：setCover 失败 → archive 删除回滚、旧 cover 保留", async () => {
    const item = addItem(t.db, { title: "local" });
    const a1 = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    const a2 = repo.addImage(item, { role: "gallery", origin: "archive" }).id;
    t.db.exec("CREATE TRIGGER fail_cover BEFORE UPDATE OF cover_image_id ON items WHEN NEW.cover_image_id = 999999 BEGIN SELECT RAISE(ABORT,'boom'); END;");
    const bytes = Buffer.from("tx-bytes");
    // 让 BOOTH 图 id 不等于 999999：先插入一张占位图，再导入
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: true, bytes }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    // 正常路径不应触发 trigger（cover 不是 999999）；此处只验证事务方法在失败时回滚
    assert.equal(out.images, 1);
    const before = images(item).map((i) => i.id);
    assert.ok(before.includes(a1) === false, "成功路径 archive 已删");
    // 直接调用事务方法并强制失败：把 cover 设为 999999
    t.db.exec("DROP TRIGGER fail_cover");
    t.db.exec("CREATE TRIGGER fail_cover2 BEFORE UPDATE OF cover_image_id ON items WHEN NEW.cover_image_id = 999999 BEGIN SELECT RAISE(ABORT,'boom'); END;");
    const a3 = repo.addImage(item, { role: "gallery", origin: "archive" }).id;
    const coverBefore = coverOf(item);
    assert.throws(() => repo.replaceArchiveImagesWithBooth(item, 999999), /boom/);
    assert.ok(repo.getImage(a3), "失败必须回滚 archive 删除");
    assert.equal(coverOf(item), coverBefore, "失败必须保留旧 cover");
    t.db.exec("DROP TRIGGER fail_cover2");
  });

  test("M2：其他条目自有 cover 不变；脏引用被清是必要行为", async () => {
    const item = addItem(t.db, { title: "local" });
    const other = addItem(t.db, { title: "other" });
    const dirty = addItem(t.db, { title: "dirty" });
    const a1 = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    const oImg = repo.addImage(other, { role: "cover", origin: "booth" }).id;
    t.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(a1, dirty);
    await importBoothUrl(repo, media, fakeClient([{ ok: true }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(coverOf(other), oImg, "其他条目自有 cover 不变");
    assert.equal(coverOf(dirty), null, "指向被删图的脏引用必须清");
  });
});

describe("fix-r2：重试/既有 BOOTH 行/原子回滚/来源 host", () => {
  test("事务失败后重试：不因 URL already 永久不清默认", async () => {
    const item = addItem(t.db, { title: "local" });
    const a1 = repo.addImage(item, { role: "cover", origin: "archive" }).id;
    const c = fakeClient([{ ok: true }]);
    t.db.exec("CREATE TRIGGER fail_cover3 BEFORE UPDATE OF cover_image_id ON items WHEN NEW.cover_image_id = 999999 BEGIN SELECT RAISE(ABORT,'boom'); END;");
    // 第一次：强制事务失败（cover 设为 999999 不可行，改用真实失败注入：临时把 setCover 目标设为不存在？）
    // 用 trigger 拦截所有 cover 更新，模拟事务失败
    t.db.exec("DROP TRIGGER fail_cover3");
    t.db.exec("CREATE TRIGGER fail_cover_all BEFORE UPDATE OF cover_image_id ON items BEGIN SELECT RAISE(ABORT,'boom'); END;");
    await assert.rejects(() => importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item }), /boom/);
    assert.equal(images(item).filter((i) => i.origin === "booth").length, 0, "失败必须回滚新 BOOTH 行");
    assert.ok(repo.getImage(a1), "失败必须保留 archive");
    t.db.exec("DROP TRIGGER fail_cover_all");
    const out = await importBoothUrl(repo, media, c, "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 1);
    assert.equal(images(item).filter((i) => i.origin === "archive").length, 0, "重试必须最终替换默认");
    assert.equal(images(item).filter((i) => i.origin === "booth").length, 1);
  });

  test("既有 BOOTH 行 + archive 默认图，重复导入同链接仍清默认", async () => {
    const item = addItem(t.db, { title: "local" });
    repo.addImage(item, { role: "cover", origin: "booth", source_url: "https://booth.pximg.net/0", sha256: sha(Buffer.from("img0")) });
    repo.addImage(item, { role: "cover", origin: "archive" });
    const out = await importBoothUrl(repo, media, fakeClient([{ ok: true }]), "https://booth.pm/ja/items/12345", { targetItemId: item });
    assert.equal(out.images, 1, "既有可用 BOOTH 图也算成功前提");
    assert.equal(images(item).filter((i) => i.origin === "archive").length, 0);
    assert.equal(images(item).filter((i) => i.origin === "booth").length, 1);
  });

  test("stageThumbs host 白名单：booth.pximg.net 抑制，其它 host 含 booth 不抑制", async () => {
    let n = 0;
    const mk = async (src: string) => {
      const item = addItem(t.db, { title: "local" });
      repo.addImage(item, { role: "gallery", origin: "user", source_url: src });
      const dir = mkdtempSync(join(tmpdir(), "av-thumb-host-"));
      const p = join(dir, "a.zip");
      writeFileSync(p, buildZip([{ name: "Assets/pic.png", data: Buffer.alloc(2048, 7) }]));
      const id = addAsset(t.db, item, rootId, "/lib/a" + (n++) + ".zip", { path: p, container: "zip", kind: "archive", size: 2048 });
      repo.replaceArchiveEntries(id, [{ path: "Assets/pic.png", size: 2048, isDir: false }]);
      try {
        await stageThumbs({ repo, media, limits: resolveLimits({}), cache: { get: async () => null, put: async () => ({ bytes: 0 }) }, log: () => {}, signal: new AbortController().signal, progress: () => {} } as any, repo.getAsset(id)!);
        return images(item).filter((i) => i.origin === "archive").length;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    assert.equal(await mk("https://booth.pximg.net/x"), 0, "合法 CDN 抑制");
    assert.equal(await mk("https://evil.example/?booth=1"), 1, "其它 host 即使含 booth 也不抑制");
  });
});
