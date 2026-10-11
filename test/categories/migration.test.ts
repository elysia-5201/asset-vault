/**
 * 物品分类 — 分类体系迁移测试（v1 → v3 与 v2 → v3）
 *
 * 被测：apps/server/src/db/migrate.ts + apps/server/src/db/schema.sql（冻结契约，见 docs/categories-v3.md §3）
 * 方法：用真 SQLite（文件库，含 WAL），不用桩替身。
 *   - v1 夹具：把当前 schema.sql **去掉 v2 内容**（items 的 13 个 cat_* 列、categories 表、分类索引）
 *     还原成 v1 结构 → 写入 v1 老数据 → migrate() → 断言。
 *   - v2 夹具：用当前 schema.sql（结构已是 v2 形态）+ 按 0.3.0 的 v2 taxonomy 播种 93 个内置分类 +
 *     写入引用旧子分类的素材与建议 → migrate() → 断言重映射与幂等。
 * 关键点：
 *  - 素材总数一字不变，且没有素材指向不存在的分类（无悬空引用）；
 *  - v2 旧子分类：改名（shoes+socks→shoes_socks、upload→installer、headwear→hat…）/
 *    合并（shader+preset+postprocess→general）/ 回退到一级（swimwear→服饰，清子分类）/
 *    整条降级（other.uncategorized→未分类，清 cat_id）；
 *  - 用户自建分类（builtin=0）与其素材一律不动；
 *  - 幂等：第二次 migrate 时 taxonomy 步 ran=false，不重复播种、行数不变。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, applyColumnMigrations, seedCategories, migrateTaxonomy, readTaxonomyVersion, SCHEMA_VERSION, TAXONOMY_VERSION } from "../../apps/server/src/db/migrate";
import { DEFAULT_TAXONOMY, UNCATEGORIZED_ID, topCategories, validateTaxonomy } from "../../packages/core/src/categories/taxonomy";

const SCHEMA_PATH = fileURLToPath(new URL("../../apps/server/src/db/schema.sql", import.meta.url));
const NOW = "2026-10-01T00:00:00.000Z";

/** v3 契约：15 一级 + 80 子分类 = 95 节点。 */
const V3_TOTAL = 95;
const V3_TOPS = 15;
const V3_SUBS = 80;

/** v2 新增列，逐字列出以便断言"齐全"。 */
const V2_ITEM_COLUMNS = [
  "cat_id", "cat_sub_id", "cat_source", "cat_confidence", "cat_reason", "cat_evidence", "cat_assigned_at",
  "cat_suggest_id", "cat_suggest_sub_id", "cat_suggest_confidence", "cat_suggest_reason", "cat_suggest_evidence", "cat_suggest_at",
];

/**
 * 把当前 schema.sql 还原成 v1：去掉 categories 表、items 的 cat_* 列与相关索引/注释。
 * 这样"旧库"与线上 v1 库结构一致，而不是手抄一份可能失真的 DDL。
 */
function v1Schema(sql: string): string {
  const V2_COLUMN_LINE = new RegExp("\\bcat_(id|sub_id|source|confidence|reason|evidence|assigned_at|suggest_id|suggest_sub_id|suggest_confidence|suggest_reason|suggest_evidence|suggest_at)\\b");
  const out: string[] = [];
  let inCategoriesTable = false;
  for (const line of sql.split(/\r?\n/)) {
    if (/^CREATE TABLE IF NOT EXISTS categories\b/.test(line)) { inCategoriesTable = true; continue; }
    if (inCategoriesTable) { if (line.trim() === ");") inCategoriesTable = false; continue; }
    if (/ix_categories_parent/.test(line)) continue;
    if (/物品分类/.test(line)) continue;
    if (V2_COLUMN_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** v2 taxonomy（0.3.0，14 主 + 79 子）——用于造真实的 v2 库，而不是只造个空表。 */
const V2_TAXONOMY: [string, string, string | null, number][] = [
  ["clothing", "服装", null, 100], ["tools", "工具", null, 200], ["accessories", "饰品", null, 300],
  ["makeup", "妆容", null, 400], ["hair", "头发", null, 500], ["models", "Avatar 与模型", null, 600],
  ["textures", "纹理与材质", null, 700], ["shaders", "Shader 与渲染", null, 800], ["animation", "动画与动作", null, 900],
  ["effects", "特效", null, 1000], ["audio", "音频", null, 1100], ["worlds", "场景与世界", null, 1200],
  ["ui", "UI 与界面", null, 1300], ["other", "其他", null, 1400],
  ["clothing.tops", "上衣", "clothing", 10], ["clothing.bottoms", "下装", "clothing", 20], ["clothing.dress", "连衣裙", "clothing", 30],
  ["clothing.suit", "套装", "clothing", 40], ["clothing.coat", "外套", "clothing", 50], ["clothing.underwear", "内衣", "clothing", 60],
  ["clothing.swimwear", "泳装", "clothing", 70], ["clothing.shoes", "鞋子", "clothing", 80], ["clothing.socks", "袜子", "clothing", 90],
  ["clothing.other", "其他服装", "clothing", 99],
  ["tools.unity", "Unity 工具", "tools", 10], ["tools.avatar_edit", "Avatar 编辑工具", "tools", 20],
  ["tools.modular_avatar", "Modular Avatar 工具", "tools", 30], ["tools.upload", "上传与管理工具", "tools", 40],
  ["tools.automation", "自动化工具", "tools", 50], ["tools.other", "其他工具", "tools", 99],
  ["accessories.headwear", "头饰", "accessories", 10], ["accessories.hair_ornament", "发饰", "accessories", 20],
  ["accessories.earring", "耳饰", "accessories", 30], ["accessories.necklace", "项链", "accessories", 40],
  ["accessories.hand", "手饰", "accessories", 50], ["accessories.glasses", "眼镜", "accessories", 60],
  ["accessories.tail", "尾巴", "accessories", 70], ["accessories.wings", "翅膀", "accessories", 80],
  ["accessories.horns", "角与兽耳", "accessories", 90], ["accessories.other", "其他饰品", "accessories", 99],
  ["makeup.eye", "眼妆", "makeup", 10], ["makeup.lip", "唇妆", "makeup", 20], ["makeup.blush", "腮红", "makeup", 30],
  ["makeup.face_texture", "面部贴图", "makeup", 40], ["makeup.skin_texture", "皮肤贴图", "makeup", 50], ["makeup.other", "其他妆容", "makeup", 99],
  ["hair.model", "发型模型", "hair", 10], ["hair.texture", "发型贴图", "hair", 20], ["hair.other", "其他头发资源", "hair", 99],
  ["models.avatar", "完整 Avatar", "models", 10], ["models.body", "身体模型", "models", 20], ["models.head", "头部模型", "models", 30],
  ["models.parts", "模型部件", "models", 40], ["models.other", "其他模型", "models", 99],
  ["textures.texture", "贴图", "textures", 10], ["textures.material", "材质", "textures", 20], ["textures.material_preset", "材质预设", "textures", 30],
  ["textures.eye", "眼睛资源", "textures", 40], ["textures.skin", "皮肤资源", "textures", 50], ["textures.other", "其他纹理材质", "textures", 99],
  ["shaders.shader", "Shader", "shaders", 10], ["shaders.preset", "Shader 预设", "shaders", 20], ["shaders.effect", "渲染效果", "shaders", 30],
  ["shaders.postprocess", "后处理", "shaders", 40], ["shaders.other", "其他渲染资源", "shaders", 99],
  ["animation.anim", "动画", "animation", 10], ["animation.dance", "舞蹈", "animation", 20], ["animation.pose", "姿势", "animation", 30],
  ["animation.expression", "表情", "animation", 40], ["animation.gesture", "手势", "animation", 50],
  ["animation.controller", "动画控制器", "animation", 60], ["animation.other", "其他动画资源", "animation", 99],
  ["effects.particle", "粒子系统", "effects", 10], ["effects.preset", "特效预设", "effects", 20], ["effects.light", "光效", "effects", 30],
  ["effects.other", "其他特效", "effects", 99],
  ["audio.sfx", "音效", "audio", 10], ["audio.music", "音乐", "audio", 20], ["audio.voice", "语音", "audio", 30], ["audio.other", "其他音频", "audio", 99],
  ["worlds.vrchat", "VRChat World", "worlds", 10], ["worlds.scene", "Unity 场景", "worlds", 20], ["worlds.skybox", "天空盒", "worlds", 30],
  ["worlds.environment", "环境资源", "worlds", 40], ["worlds.other", "其他场景资源", "worlds", 99],
  ["ui.component", "UI 组件", "ui", 10], ["ui.icon", "图标", "ui", 20], ["ui.hud", "HUD", "ui", 30], ["ui.menu", "菜单", "ui", 40],
  ["ui.other", "其他 UI 资源", "ui", 99],
  ["other.uncategorized", "未分类", "other", 10], ["other.review", "待人工确认", "other", 20], ["other.misc", "其他资源", "other", 99],
];

interface Fixture {
  db: Database.Database;
  dir: string;
  file: string;
  /** 建库时 items 的列名（迁移后用它取"老数据"快照，新列不参与比较）。 */
  columns: string[];
  close: () => void;
}

function makeDb(setup: (db: Database.Database) => void): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "av-cat-mig-"));
  const file = join(dir, "fixture.db");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  setup(db);
  return { db, dir, file, columns: [], close: () => { try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

/** 建一个真实 v1 库（文件库，含 WAL）。 */
function openV1(): Fixture & { itemId: number; rowBefore: Record<string, unknown> } {
  const f = makeDb((db) => {
    db.exec(v1Schema(readFileSync(SCHEMA_PATH, "utf8")));
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', '1')").run();
  });
  const columns = (f.db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((r) => r.name);
  const info = f.db.prepare(`INSERT INTO items(uid, source_site, source_item_id, source_url, canonical_url, title, title_ja,
      shop_name, shop_subdomain, author, price_text, price_yen, purchased, published_at, category_name, category_parent,
      description, adult, status, rating, favorite, notes, compat_declared_count, id_confidence, id_match_method,
      source_gone, last_checked_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("uid-v1-legacy-1", "booth", "6115428", "https://booth.pm/ja/items/6115428", "https://booth.pm/ja/items/6115428",
      "真実の穴 V2 対応衣装セット", "真実の穴 V2 衣装", "サンプルショップ", "sample", "サンプル作者", "¥1,500", 1500, 1,
      "2026-09-01T00:00:00.000Z", "衣装", "3Dモデル", "説明文", 1, "stored", 5, 1, "備考メモ", 12, 0.9, "booth-id",
      0, NOW, NOW, NOW);
  const itemId = Number(info.lastInsertRowid);
  const rowBefore = f.db.prepare(`SELECT ${columns.join(",")} FROM items WHERE id = ?`).get(itemId) as Record<string, unknown>;
  return { ...f, columns, itemId, rowBefore };
}

/** 造一个真实的 v2 库：v2 结构 + v2 taxonomy（93 内置分类）+ 用户自建分类 + 引用旧子分类的素材/建议。 */
function openV2(): Fixture & { ids: Record<string, number> } {
  const f = makeDb((db) => {
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', '2')").run();
    const ins = db.prepare("INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)");
    for (const [id, name, parentId, sort] of V2_TAXONOMY) ins.run(id, name, parentId, sort, NOW, NOW);
    // 用户自建分类（builtin=0）：迁移必须一字不动
    const insUser = db.prepare("INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)");
    insUser.run("my.custom", "我的自建分类", null, 5000, 1, NOW, NOW);
    insUser.run("my.custom.sub", "自建子分类", "my.custom", 10, 0, NOW, NOW);
  });
  const addItem = (o: { uid: string; title: string; catId?: string | null; catSubId?: string | null; catSource?: string | null; suggestId?: string | null; suggestSubId?: string | null }): number => {
    const info = f.db.prepare(`INSERT INTO items(uid, source_site, source_item_id, title, status,
        cat_id, cat_sub_id, cat_source, cat_confidence, cat_assigned_at,
        cat_suggest_id, cat_suggest_sub_id, cat_suggest_confidence, cat_suggest_at, created_at, updated_at)
      VALUES (?,?,?,?, 'active', ?,?,?,?,?, ?,?,?,?, ?,?)`)
      .run(o.uid, "booth", o.uid, o.title,
        o.catId ?? null, o.catSubId ?? null, o.catSource ?? null, o.catSource ? 1 : null, o.catSource ? NOW : null,
        o.suggestId ?? null, o.suggestSubId ?? null, o.suggestId ? 0.6 : null, o.suggestId ? NOW : null,
        NOW, NOW);
    return Number(info.lastInsertRowid);
  };
  const ids: Record<string, number> = {};
  ids.swimwear = addItem({ uid: "v2-swimwear", title: "水着 衣装", catId: "clothing", catSubId: "clothing.swimwear", catSource: "auto" });
  ids.shader = addItem({ uid: "v2-shader", title: "lilToon シェーダー", catId: "shaders", catSubId: "shaders.shader", catSource: "auto" });
  ids.upload = addItem({ uid: "v2-upload", title: "アップロード補助", catId: "tools", catSubId: "tools.upload", catSource: "manual" });
  ids.otherUnc = addItem({ uid: "v2-other-unc", title: "未分類のもの", catId: "other", catSubId: "other.uncategorized", catSource: "manual" });
  ids.plain = addItem({ uid: "v2-plain", title: "まだ分類していない", catId: null });
  ids.user = addItem({ uid: "v2-user", title: "自建分类下的素材", catId: "my.custom", catSubId: "my.custom.sub", catSource: "manual" });
  ids.suggest = addItem({ uid: "v2-suggest", title: "お着替えツール", catId: "clothing", catSubId: "clothing.tops", catSource: "manual", suggestId: "tools", suggestSubId: "tools.modular_avatar" });
  return { ...f, ids };
}

const itemColumns = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((r) => r.name);
const count = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const snapshot = (f: Fixture & { itemId: number; columns: string[] }): Record<string, unknown> =>
  JSON.parse(JSON.stringify(f.db.prepare(`SELECT ${f.columns.join(",")} FROM items WHERE id = ?`).get(f.itemId))) as Record<string, unknown>;
const catRow = (db: Database.Database, id: string): any =>
  db.prepare("SELECT id, name, parent_id AS parentId, sort, enabled, builtin FROM categories WHERE id=?").get(id);
const itemRow = (db: Database.Database, id: number): any =>
  db.prepare("SELECT id, cat_id, cat_sub_id, cat_source, cat_suggest_id, cat_suggest_sub_id FROM items WHERE id=?").get(id);

describe("夹具自检（防止夹具就带着目标结构导致假绿）", () => {
  test("v1 夹具：没有 categories 表、没有 13 个 cat_* 列、schema_meta.version='1'、1 条老素材", () => {
    const v1 = v1Schema(readFileSync(SCHEMA_PATH, "utf8"));
    assert.equal(/CREATE TABLE IF NOT EXISTS categories/.test(v1), false, "v1 不应有 categories 表");
    for (const c of V2_ITEM_COLUMNS) assert.equal(v1.includes(c), false, "v1 不应有列 " + c);
    assert.equal(/ix_items_cat/.test(v1), false, "v1 不应有分类索引");
    for (const t of ["schema_meta", "library_roots", "items", "assets", "avatars", "tags", "jobs"]) assert.ok(v1.includes(t), "v1 必须仍有 " + t);

    const f = openV1();
    try {
      assert.equal(itemColumns(f.db).filter((n) => n.startsWith("cat_")).length, 0, "v1 items 不得有 cat_* 列");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='categories'"), 0);
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "1");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1);
      assert.equal(f.rowBefore.title, "真実の穴 V2 対応衣装セット");
    } finally { f.close(); }
  });

  test("v2 夹具：93 个内置分类（14 主 + 79 子）+ 2 个自建 + 7 条素材，且没有 taxonomy_version", () => {
    const f = openV2();
    try {
      assert.equal(V2_TAXONOMY.length, 93, "v2 taxonomy 夹具必须是 93 个节点");
      assert.equal(V2_TAXONOMY.filter(([, , p]) => p === null).length, 14);
      assert.equal(V2_TAXONOMY.filter(([, , p]) => p !== null).length, 79);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 95, "93 内置 + 2 自建");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE builtin=1"), 93);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 7);
      assert.equal(readTaxonomyVersion(f.db), null, "夹具不得预置 taxonomy_version，否则迁移不跑");
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "2");
    } finally { f.close(); }
  });
});

describe("migrate()：v1 → v3", () => {
  test("schema_meta.version='3' / taxonomy_version='3'，13 个 cat_* 列齐全，categories 95 行（15 主 + 80 子）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      assert.equal(SCHEMA_VERSION, 3);
      assert.equal(TAXONOMY_VERSION, "3");
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "3");
      assert.equal(readTaxonomyVersion(f.db), "3");

      const cols = itemColumns(f.db);
      for (const c of V2_ITEM_COLUMNS) assert.ok(cols.includes(c), "缺少新列 " + c);
      assert.deepEqual(cols.filter((n) => n.startsWith("cat_")).sort(), [...V2_ITEM_COLUMNS].sort(), "cat_* 列集合必须恰好是这 13 个");

      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE parent_id IS NULL"), V3_TOPS);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE parent_id IS NOT NULL"), V3_SUBS);
      assert.equal(DEFAULT_TAXONOMY.length, V3_TOTAL);
      assert.equal(topCategories().length, V3_TOPS);

      // 播种结果与冻结契约逐项一致（不只数数）
      const dbRows = (f.db.prepare("SELECT id, name, parent_id AS parentId, sort, enabled, builtin FROM categories").all() as any[])
        .map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null, sort: r.sort, enabled: r.enabled !== 0, builtin: r.builtin !== 0 }));
      assert.deepEqual(validateTaxonomy(dbRows), []);
      const byId = new Map(dbRows.map((r) => [r.id, r]));
      for (const d of DEFAULT_TAXONOMY) {
        assert.deepEqual(byId.get(d.id), { ...d }, "分类与契约不一致: " + d.id);
      }

      // 迁移痕迹留档
      const mig = f.db.prepare("SELECT value FROM schema_meta WHERE key='migrated_v2'").get() as { value: string } | undefined;
      assert.ok(mig, "应写入 migrated_v2（13 个新列）");
      assert.equal((JSON.parse(mig!.value) as { columns: string[] }).columns.length, 13);
    } finally { f.close(); }
  });

  test("旧行数据一字不改，且迁移后 cat_id IS NULL（历史素材 = 未分类）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      assert.deepEqual(snapshot(f), JSON.parse(JSON.stringify(f.rowBefore)), "v1 每一列都必须保持不变");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1, "迁移不得增删条目");
      const nulls = f.db.prepare(`SELECT ${V2_ITEM_COLUMNS.join(",")} FROM items WHERE id = ?`).get(f.itemId) as Record<string, unknown>;
      for (const c of V2_ITEM_COLUMNS) assert.equal(nulls[c], null, c + " 迁移后必须为 NULL");
      assert.equal(itemRow(f.db, f.itemId).cat_id, null, "cat_id IS NULL = 未分类");
    } finally { f.close(); }
  });

  test("系统分类「未分类」：一级、builtin=1、无子分类，且不把素材塞进这一行（存储仍是 NULL）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      const unc = catRow(f.db, UNCATEGORIZED_ID);
      assert.ok(unc, "未分类必须被播种");
      assert.equal(unc.parentId, null);
      assert.equal(unc.builtin, 1);
      assert.equal(unc.enabled, 1);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE parent_id='" + UNCATEGORIZED_ID + "'"), 0);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_id='" + UNCATEGORIZED_ID + "'"), 0, "未分类不是一条归属，存储仍是 cat_id IS NULL");
    } finally { f.close(); }
  });

  test("幂等：连跑两次不报错、不重复播种、行数不变、不再重复加列（taxonomy 步 ran=false）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      const afterFirst = snapshot(f);
      assert.doesNotThrow(() => migrate(f.db));
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL, "第二次 migrate 不得重复播种");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1);
      assert.deepEqual(snapshot(f), afterFirst, "第二次 migrate 后老行仍不变");
      assert.deepEqual(applyColumnMigrations(f.db), [], "列已存在 → 不再 ALTER（幂等）");
      assert.equal(migrateTaxonomy(f.db).ran, false, "已是最新 taxonomy → 不跑");
      assert.equal(seedCategories(f.db), 0, "第二次播种新增 0 行");
      assert.equal(readTaxonomyVersion(f.db), "3");
    } finally { f.close(); }
  });

  test("用户自建分类（builtin=0）迁移后保留，且不被覆盖", () => {
    const f = openV1();
    try {
      migrate(f.db);
      f.db.prepare(`INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at)
        VALUES ('my.custom', '我的自建分类', NULL, 5000, 1, 0, ?, ?)`).run(NOW, NOW);
      f.db.prepare(`INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at)
        VALUES ('my.custom.sub', '自建子分类', 'my.custom', 10, 0, 0, ?, ?)`).run(NOW, NOW);
      // 用户改过的内置分类：改名/停用不得被迁移复位
      f.db.prepare("UPDATE categories SET name='服饰（我的叫法）', sort=999, enabled=0 WHERE id='clothing'").run();
      migrate(f.db);
      const rows = f.db.prepare("SELECT id, name, parent_id AS parentId, sort, enabled, builtin FROM categories WHERE id LIKE 'my.custom%' ORDER BY id").all() as any[];
      assert.equal(rows.length, 2, "自建分类必须保留");
      assert.deepEqual(rows[0], { id: "my.custom", name: "我的自建分类", parentId: null, sort: 5000, enabled: 1, builtin: 0 });
      assert.deepEqual(rows[1], { id: "my.custom.sub", name: "自建子分类", parentId: "my.custom", sort: 10, enabled: 0, builtin: 0 });
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL + 2, "95 内置 + 2 自建");
      const clothing = catRow(f.db, "clothing");
      assert.equal(clothing.name, "服饰（我的叫法）", "第二次 migrate 不该跑（taxonomy 已是最新），用户改名保留");
      assert.equal(clothing.sort, 999);
      assert.equal(clothing.enabled, 0, "用户停用不得被复位");
    } finally { f.close(); }
  });

  test("已是最新 taxonomy 时不再播种：删掉的内置分类不会被复活（v3 语义，删分类只能由管理页的停用替代）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      f.db.prepare("DELETE FROM categories WHERE id='hair.bangs'").run();
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL - 1);
      migrate(f.db);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL - 1, "taxonomy_version 已是 3 → 不重新播种（不复活被删分类）");
      assert.equal(migrateTaxonomy(f.db).ran, false);
    } finally { f.close(); }
  });
});

describe("migrate()：v2 → v3", () => {
  test("categories：93 → 95 内置（15 主 + 80 子），v2 的 47 个旧子分类全部下线，用户自建分类保留", () => {
    const f = openV2();
    try {
      const before = count(f.db, "SELECT COUNT(*) n FROM categories");
      migrate(f.db);
      assert.equal(SCHEMA_VERSION, 3);
      assert.equal(readTaxonomyVersion(f.db), "3");
      assert.equal(before, 95, "v2 库：93 内置 + 2 自建");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE builtin=1"), V3_TOTAL);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE builtin=1 AND parent_id IS NULL"), V3_TOPS);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE builtin=1 AND parent_id IS NOT NULL"), V3_SUBS);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), V3_TOTAL + 2, "自建分类必须保留");
      for (const legacy of ["clothing.swimwear", "clothing.shoes", "clothing.socks", "tools.upload", "tools.modular_avatar",
        "shaders.shader", "other.uncategorized", "other.review", "other.misc", "hair.model", "ui.component", "audio.music"]) {
        assert.equal(catRow(f.db, legacy), undefined, "v2 旧子分类必须已删除: " + legacy);
      }
      assert.deepEqual(catRow(f.db, "my.custom"), { id: "my.custom", name: "我的自建分类", parentId: null, sort: 5000, enabled: 1, builtin: 0 });
      assert.deepEqual(catRow(f.db, "my.custom.sub"), { id: "my.custom.sub", name: "自建子分类", parentId: "my.custom", sort: 10, enabled: 0, builtin: 0 });
    } finally { f.close(); }
  });

  test("引用旧子分类的素材被正确重映射（改名 / 合并 / 回退到一级 / 整条未分类）", () => {
    const f = openV2();
    try {
      migrate(f.db);
      // clothing.swimwear →（父）：主分类保留，子分类清空
      const a = itemRow(f.db, f.ids.swimwear!);
      assert.equal(a.cat_id, "clothing");
      assert.equal(a.cat_sub_id, null, "swimwear 在 v3 没有对应子分类 → 回退到「服饰」");
      // shaders.shader → shaders.general
      const b = itemRow(f.db, f.ids.shader!);
      assert.equal(b.cat_id, "shaders");
      assert.equal(b.cat_sub_id, "shaders.general");
      // tools.upload → tools.installer
      const c = itemRow(f.db, f.ids.upload!);
      assert.equal(c.cat_id, "tools");
      assert.equal(c.cat_sub_id, "tools.installer");
      // other.uncategorized → 整条未分类（cat_id 也清空）
      const d = itemRow(f.db, f.ids.otherUnc!);
      assert.equal(d.cat_id, null, "「其他 › 未分类」整条降级为未分类");
      assert.equal(d.cat_sub_id, null);
      assert.equal(d.cat_source, null);
      // 本来就未分类的素材：不动
      const e = itemRow(f.db, f.ids.plain!);
      assert.equal(e.cat_id, null);
      // 自建分类下的素材：一字不动
      const g = itemRow(f.db, f.ids.user!);
      assert.equal(g.cat_id, "my.custom");
      assert.equal(g.cat_sub_id, "my.custom.sub");
      assert.equal(g.cat_source, "manual");
    } finally { f.close(); }
  });

  test("待确认建议一起重映射：被删子分类的建议改指新 ID，普通素材归属不受影响", () => {
    const f = openV2();
    try {
      migrate(f.db);
      const h = itemRow(f.db, f.ids.suggest!);
      assert.equal(h.cat_id, "clothing", "已定归属不得被迁移改动");
      assert.equal(h.cat_sub_id, "clothing.tops");
      assert.equal(h.cat_suggest_id, "tools", "一级建议保留");
      assert.equal(h.cat_suggest_sub_id, "tools.avatar", "tools.modular_avatar → v3 tools.avatar");
    } finally { f.close(); }
  });

  test("素材总数不变，且没有素材指向不存在的分类（无悬空引用）", () => {
    const f = openV2();
    try {
      const before = count(f.db, "SELECT COUNT(*) n FROM items");
      migrate(f.db);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), before, "迁移绝不增删素材");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_id IS NOT NULL AND cat_id NOT IN (SELECT id FROM categories)"), 0, "cat_id 悬空");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_sub_id IS NOT NULL AND cat_sub_id NOT IN (SELECT id FROM categories WHERE parent_id IS NOT NULL)"), 0, "cat_sub_id 悬空");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_suggest_id IS NOT NULL AND cat_suggest_id NOT IN (SELECT id FROM categories)"), 0, "建议悬空");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_suggest_sub_id IS NOT NULL AND cat_suggest_sub_id NOT IN (SELECT id FROM categories WHERE parent_id IS NOT NULL)"), 0, "建议子分类悬空");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items WHERE cat_id='" + UNCATEGORIZED_ID + "'"), 0, "未分类的规范存储仍是 NULL");
    } finally { f.close(); }
  });

  test("幂等：第二次 migrate taxonomy 步 ran=false，分类行数与所有归属一字不变", () => {
    const f = openV2();
    try {
      migrate(f.db);
      const cats = count(f.db, "SELECT COUNT(*) n FROM categories");
      const before = f.db.prepare("SELECT id, cat_id, cat_sub_id, cat_source, cat_suggest_id, cat_suggest_sub_id FROM items ORDER BY id").all();
      assert.doesNotThrow(() => migrate(f.db));
      assert.equal(migrateTaxonomy(f.db).ran, false, "第二次必须 ran=false");
      assert.equal(seedCategories(f.db), 0);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), cats);
      assert.deepEqual(f.db.prepare("SELECT id, cat_id, cat_sub_id, cat_source, cat_suggest_id, cat_suggest_sub_id FROM items ORDER BY id").all(), before);
      assert.equal(readTaxonomyVersion(f.db), "3");
    } finally { f.close(); }
  });

  test("迁移痕迹留档：taxonomy_v3_migration 记录 before/after 计数与重映射规模", () => {
    const f = openV2();
    try {
      migrate(f.db);
      const row = f.db.prepare("SELECT value FROM schema_meta WHERE key='taxonomy_v3_migration'").get() as { value: string } | undefined;
      assert.ok(row, "应写入 taxonomy_v3_migration");
      const rec = JSON.parse(row!.value) as {
        from: string | null; to: string; ran: boolean; inserted: number; removed: number;
        remappedItems: number; uncategorizedItems: number; userCategoriesKept: number;
        before: { items: number; categorized: number; categories: number };
        after: { items: number; categories: number };
      };
      assert.equal(rec.from, null, "v2 库没有 taxonomy_version");
      assert.equal(rec.to, "3");
      assert.equal(rec.ran, true);
      // 49 个新节点 = 95 - 14（v2 已有的一级）- 32（v2 里 ID 沿用下来的子分类）
      assert.equal(rec.inserted, 49, "新增分类节点数");
      // 46 个 v2 旧子分类（47 个未沿用 ID 的子分类里，「其他 › 未分类」单独先删）+ 该行本身 = 47
      assert.equal(rec.removed, 47, "删除的旧分类行数");
      assert.equal(rec.remappedItems, 3, "被改指子分类的素材数（swimwear / shader / upload）");
      assert.equal(rec.uncategorizedItems, 1, "「其他 › 未分类」降级的素材数");
      assert.equal(rec.userCategoriesKept, 2);
      assert.equal(rec.before.items, 7);
      assert.equal(rec.after.items, rec.before.items, "迁移不得增删素材");
      assert.equal(rec.before.categories, 95);
      assert.equal(rec.after.categories, V3_TOTAL + 2);
    } finally { f.close(); }
  });
});
