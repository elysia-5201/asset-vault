import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_TAXONOMY, UNCATEGORIZED_ID } from "../../../../packages/core/src/categories/taxonomy";

/** 数据库结构版本：v1=15 张核心表；v2=物品分类；v3=分类体系 v3；v4=扫描变更中心；v5=深度索引流水线/派生缓存；
 *  v6=jobs 租约/心跳列（辅助元数据，不改状态机）+ cache_entries.weak（缓存弱身份标记）；
 *  v7=index_tasks 租约围栏列（owner/lease_token/job_id）+ (job_id,state) 索引；
 *  v8=工作台：asset_units/unit_relations + import_plans/plan_items/runs/run_items（新表，无老表改列）；
 *  v9=导入可靠性：import_plans.risk_json/risk_state、import_runs.verification_scope/checked/expected + staging_files */
export const SCHEMA_VERSION = 9;
/** 分类体系模板版本（与 SCHEMA_VERSION 独立：以后只调分类模板时不必动表结构版本） */
export const TAXONOMY_VERSION = "3";

const defaultSchemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * 加列迁移（幂等）。schema.sql 用 CREATE TABLE IF NOT EXISTS，对已存在的表不补列，
 * 而 schema.sql 里针对新列建的索引又必须能执行 → 必须先补列再执行 schema.sql。
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: "items", column: "cat_id", ddl: "TEXT" },
  { table: "items", column: "cat_sub_id", ddl: "TEXT" },
  { table: "items", column: "cat_source", ddl: "TEXT" },
  { table: "items", column: "cat_confidence", ddl: "REAL" },
  { table: "items", column: "cat_reason", ddl: "TEXT" },
  { table: "items", column: "cat_evidence", ddl: "TEXT" },
  { table: "items", column: "cat_assigned_at", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_id", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_sub_id", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_confidence", ddl: "REAL" },
  { table: "items", column: "cat_suggest_reason", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_evidence", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_at", ddl: "TEXT" },
  // v5：深度索引状态（老库补列；新库由 schema.sql 直接建）
  { table: "assets", column: "index_state", ddl: "TEXT NOT NULL DEFAULT 'pending'" },
  { table: "assets", column: "index_error", ddl: "TEXT" },
  { table: "assets", column: "indexed_at", ddl: "TEXT" },
  { table: "assets", column: "content_version", ddl: "TEXT" },
  // v6：jobs 租约/心跳（只加列，不改状态机；旧代码可忽略这些列 → 回滚只需回滚代码）
  { table: "jobs", column: "holder", ddl: "TEXT" },
  { table: "jobs", column: "lease_until", ddl: "TEXT" },
  { table: "jobs", column: "lease_token", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "jobs", column: "heartbeat_at", ddl: "TEXT" },
  // v6：cache_entries.weak（派生缓存弱身份标记；旧库补列后默认 0=强身份，语义不变）
  { table: "cache_entries", column: "weak", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // v7：index_tasks 租约围栏（辅助元数据；旧行 owner NULL/lease_token=0，未围栏写入仍兼容）
  { table: "index_tasks", column: "owner", ddl: "TEXT" },
  { table: "index_tasks", column: "lease_token", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "index_tasks", column: "job_id", ddl: "INTEGER" },
  // v9：导入风险/验证覆盖（老库补列；新库由 schema.sql 建）
  { table: "import_plans", column: "risk_json", ddl: "TEXT" },
  { table: "import_plans", column: "risk_state", ddl: "TEXT" },
  { table: "import_runs", column: "verification_scope", ddl: "TEXT" },
  { table: "import_runs", column: "checked_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "import_runs", column: "expected_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
];

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function applyColumnMigrations(db: Database.Database): string[] {
  const added: string[] = [];
  for (const m of COLUMN_MIGRATIONS) {
    const cols = tableColumns(db, m.table);
    if (cols.size === 0) continue; // 表还不存在 → 交给 schema.sql
    if (cols.has(m.column)) continue;
    db.exec("ALTER TABLE " + m.table + " ADD COLUMN " + m.column + " " + m.ddl);
    added.push(m.table + "." + m.column);
  }
  return added;
}

// ---------- 分类模板 v2 → v3 ----------

/**
 * v2 子分类 ID → v3 子分类 ID（null = 回到其一级分类，即只清空子分类）。
 * 只处理**系统分类**（builtin=1）：用户自建分类（builtin=0）一律不动。
 * 说明：映射一律保持在同一个一级分类内，避免"迁移顺手把素材换了大类"。
 */
const V2_TO_V3_CHILD: Readonly<Record<string, string | null>> = {
  "clothing.tops": "clothing.tops",
  "clothing.bottoms": "clothing.bottoms",
  "clothing.dress": "clothing.dress",
  "clothing.coat": "clothing.coat",
  "clothing.suit": "clothing.suit",
  "clothing.underwear": "clothing.underwear",
  "clothing.shoes": "clothing.shoes_socks",
  "clothing.socks": "clothing.shoes_socks",
  "clothing.swimwear": null,
  "clothing.other": null,
  "makeup.eye": "makeup.eyeshadow",
  "makeup.lip": "makeup.lips",
  "makeup.blush": "makeup.blush",
  "makeup.face_texture": "makeup.fullface",
  "makeup.skin_texture": "makeup.fullface",
  "makeup.other": null,
  "hair.model": "hair.set",
  "hair.texture": null,
  "hair.other": null,
  "models.avatar": "models.avatar",
  "models.body": "models.body",
  "models.head": "models.head",
  "models.parts": null,
  "models.other": null,
  "textures.eye": "textures.eye",
  "textures.skin": "textures.skin",
  "textures.texture": null,
  "textures.material": null,
  "textures.material_preset": null,
  "textures.other": null,
  "shaders.shader": "shaders.general",
  "shaders.preset": "shaders.general",
  "shaders.effect": "shaders.effect",
  "shaders.postprocess": "shaders.general",
  "shaders.other": null,
  "animation.dance": "animation.dance",
  "animation.pose": "animation.pose",
  "animation.expression": "animation.expression",
  "animation.gesture": "animation.gesture",
  "animation.anim": null,
  "animation.controller": null,
  "animation.other": null,
  "effects.particle": "effects.particle",
  "effects.light": "effects.light",
  "effects.preset": null,
  "effects.other": null,
  "tools.unity": "tools.unity",
  "tools.avatar_edit": "tools.avatar",
  "tools.modular_avatar": "tools.avatar",
  "tools.upload": "tools.installer",
  "tools.automation": "tools.script",
  "tools.other": null,
  "accessories.headwear": "accessories.hat",
  "accessories.hair_ornament": "accessories.hair_ornament",
  "accessories.earring": "accessories.earring",
  "accessories.necklace": "accessories.necklace",
  "accessories.hand": "accessories.ring",
  "accessories.glasses": "accessories.glasses",
  "accessories.tail": "accessories.tail",
  "accessories.wings": "accessories.wings",
  "accessories.horns": null,
  "accessories.other": null,
  "audio.sfx": "audio.sfx",
  "audio.music": "audio.bgm",
  "audio.voice": "audio.voice",
  "audio.other": null,
  "worlds.vrchat": "worlds.world",
  "worlds.scene": "worlds.world",
  "worlds.skybox": "worlds.skybox",
  "worlds.environment": null,
  "worlds.other": null,
  "ui.component": "ui.interactive",
  "ui.icon": "ui.icon",
  "ui.hud": "ui.hud",
  "ui.menu": "ui.menu",
  "ui.other": null,
  "other.review": "other.pending",
  "other.misc": "other.unclassed",
};

/** 「其他 › 未分类」（v2）整条降级为未分类（清空归属，不只是清子分类） */
const FULLY_UNCATEGORIZED = "other.uncategorized";

export interface TaxonomyMigrationResult {
  ran: boolean;
  inserted: number;
  renamed: number;
  removed: number;
  remappedItems: number;
  uncategorizedItems: number;
  userCategoriesKept: number;
  taxonomyVersion: string;
}

export function readTaxonomyVersion(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='taxonomy_version'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * 分类模板迁移（幂等 + 事务）。
 *  - 已存在的 ID：更新 name / parent_id / sort / builtin，**保留用户设置的 enabled**；
 *  - 不存在的：按模板新建（enabled=1）；
 *  - v2 有、v3 没有的**系统**子分类：先把素材与建议改指到映射目标（无对应→回到一级分类），再删除该行；
 *  - 用户自建分类（builtin=0）不动；
 *  - 只约束用户操作的"内置不可删"不适用于迁移本身。
 */
export function migrateTaxonomy(db: Database.Database, log: (m: string) => void = () => {}): TaxonomyMigrationResult {
  const current = readTaxonomyVersion(db);
  const noTable = tableColumns(db, "categories").size === 0;
  const result: TaxonomyMigrationResult = {
    ran: false, inserted: 0, renamed: 0, removed: 0, remappedItems: 0, uncategorizedItems: 0,
    userCategoriesKept: 0, taxonomyVersion: TAXONOMY_VERSION,
  };
  if (noTable) return result; // schema.sql 还没建表（新库）：交给下面 exec(schema.sql) 后再跑一次
  if (current === TAXONOMY_VERSION) return result;

  const t = new Date().toISOString();
  const v3Ids = new Set(DEFAULT_TAXONOMY.map((d) => d.id));
  const tx = db.transaction(() => {
    const before = {
      items: (db.prepare("SELECT COUNT(*) c FROM items").get() as any).c,
      categorized: (db.prepare("SELECT COUNT(*) c FROM items WHERE cat_id IS NOT NULL").get() as any).c,
      categories: (db.prepare("SELECT COUNT(*) c FROM categories").get() as any).c,
    };

    // 1) 先处理「其他 › 未分类」→ 整条未分类（要在通用循环之前，否则子分类已被清空就找不到它了）
    result.uncategorizedItems = db.prepare(
      "UPDATE items SET cat_id=NULL, cat_sub_id=NULL, cat_source=NULL, cat_confidence=NULL, cat_reason=NULL, cat_evidence=NULL, cat_assigned_at=NULL, " +
      "cat_suggest_id=NULL, cat_suggest_sub_id=NULL, cat_suggest_confidence=NULL, cat_suggest_reason=NULL, cat_suggest_evidence=NULL, cat_suggest_at=NULL, updated_at=? " +
      "WHERE cat_id='other' AND cat_sub_id=?"
    ).run(t, FULLY_UNCATEGORIZED).changes;
    // 这一行本身也要删掉（它是 v2 的"其他 › 未分类"，v3 里由系统一级分类代替；上面的素材已降级为未分类）
    result.removed += db.prepare("DELETE FROM categories WHERE id=?").run(FULLY_UNCATEGORIZED).changes;

    // 2) 模板 upsert（保留 enabled、保留用户自建分类）
    const ins = db.prepare(
      "INSERT INTO categories(id,name,parent_id,sort,enabled,builtin,created_at,updated_at) VALUES (?,?,?,?,1,1,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, sort=excluded.sort, builtin=1, updated_at=excluded.updated_at"
    );
    const existsStmt = db.prepare("SELECT name, parent_id, sort FROM categories WHERE id=?");
    for (const d of DEFAULT_TAXONOMY) {
      const prev = existsStmt.get(d.id) as any;
      if (!prev) {
        ins.run(d.id, d.name, d.parentId, d.sort, t, t);
        result.inserted++;
      } else {
        if (prev.name !== d.name || prev.parent_id !== d.parentId || prev.sort !== d.sort) result.renamed++;
        ins.run(d.id, d.name, d.parentId, d.sort, t, t);
      }
    }

    // 3) 旧系统子分类（v2 有、v3 没有）→ 迁移引用后删除
    const obsolete = (db.prepare("SELECT id FROM categories WHERE builtin=1 AND parent_id IS NOT NULL AND id <> ?").all(FULLY_UNCATEGORIZED) as { id: string }[])
      .map((r) => r.id).filter((id) => !v3Ids.has(id));
    for (const oldId of obsolete) {
      // 映射表里没有的（v2 有、v3 没有的系统子分类）一律按"无对应"处理：素材回到一级分类，然后删掉该行
      const mapped = Object.prototype.hasOwnProperty.call(V2_TO_V3_CHILD, oldId) ? V2_TO_V3_CHILD[oldId] : null;
      if (mapped) {
        result.remappedItems += db.prepare("UPDATE items SET cat_sub_id=?, updated_at=? WHERE cat_sub_id=?").run(mapped, t, oldId).changes;
        db.prepare("UPDATE items SET cat_suggest_sub_id=? WHERE cat_suggest_sub_id=?").run(mapped, oldId);
      } else {
        result.remappedItems += db.prepare("UPDATE items SET cat_sub_id=NULL, updated_at=? WHERE cat_sub_id=?").run(t, oldId).changes;
        db.prepare("UPDATE items SET cat_suggest_sub_id=NULL WHERE cat_suggest_sub_id=?").run(oldId);
      }
      result.removed += db.prepare("DELETE FROM categories WHERE id=?").run(oldId).changes;
    }

    // 4) 防御：指向已不存在分类的素材 → 回到未分类（不留悬空引用）
    result.remappedItems += db.prepare(
      "UPDATE items SET cat_id=NULL, cat_sub_id=NULL, cat_source=NULL, cat_confidence=NULL, updated_at=? WHERE cat_id IS NOT NULL AND cat_id NOT IN (SELECT id FROM categories)"
    ).run(t).changes;
    db.prepare("UPDATE items SET cat_suggest_id=NULL, cat_suggest_sub_id=NULL, cat_suggest_confidence=NULL, cat_suggest_reason=NULL, cat_suggest_evidence=NULL, cat_suggest_at=NULL " +
      "WHERE cat_suggest_id IS NOT NULL AND cat_suggest_id NOT IN (SELECT id FROM categories)").run();
    // 子分类的父必须是一级分类（防御：悬空子分类引用）
    db.prepare("UPDATE items SET cat_sub_id=NULL WHERE cat_sub_id IS NOT NULL AND cat_sub_id NOT IN (SELECT id FROM categories WHERE parent_id IS NOT NULL)").run();

    result.userCategoriesKept = (db.prepare("SELECT COUNT(*) c FROM categories WHERE builtin=0").get() as any).c;

    const after = {
      items: (db.prepare("SELECT COUNT(*) c FROM items").get() as any).c,
      categories: (db.prepare("SELECT COUNT(*) c FROM categories").get() as any).c,
    };
    const record = { from: current, to: TAXONOMY_VERSION, at: t, before, after, ...result, ran: true };
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('taxonomy_v3_migration', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(record));
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('taxonomy_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(TAXONOMY_VERSION);
    if (before.items !== after.items) throw new Error("taxonomy migration 会改动素材条数，已回滚：" + before.items + " → " + after.items);
    result.ran = true;
    log("taxonomy v" + TAXONOMY_VERSION + ": +" + result.inserted + " 更新 " + result.renamed + " 删除旧子分类 " + result.removed +
      " 迁移素材 " + result.remappedItems + " 降级未分类 " + result.uncategorizedItems + " 保留用户分类 " + result.userCategoriesKept);
  });
  tx();
  return result;
}

/** 兼容旧调用名：播种/升级分类模板（幂等，已是最新模板时返回 0）。 */
export function seedCategories(db: Database.Database): number {
  const r = migrateTaxonomy(db);
  return r.ran ? r.inserted + r.renamed + r.removed : 0;
}

/** Apply the schema (idempotent) and record the schema version. */
export function migrate(db: Database.Database, schemaFile?: string): void {
  const addedColumns = applyColumnMigrations(db);
  const sql = readFileSync(schemaFile ?? defaultSchemaPath, "utf8");
  db.exec(sql);
  const taxonomy = migrateTaxonomy(db);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  if (addedColumns.length) {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('migrated_v2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: new Date().toISOString(), columns: addedColumns }));
  }
  if (taxonomy.ran && taxonomy.removed === 0 && taxonomy.remappedItems === 0) {
    // 纯新增（新库）：只在启动日志里说一声，避免噪音
  }
}

export function openDatabase(file: string, schemaFile?: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, schemaFile);
  return db;
}
