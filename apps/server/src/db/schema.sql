-- AssetVault schema v1 — 15 core tables + FTS5(trigram)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS library_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  path_norm TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'index_in_place',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_url TEXT,
  file_path TEXT,
  thumb_path TEXT,
  width INTEGER, height INTEGER, bytes INTEGER,
  sha256 TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_images_item_sha ON item_images(item_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_images_item ON item_images(item_id, position);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  source_site TEXT NOT NULL DEFAULT 'local',
  source_item_id TEXT,
  source_url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  title_ja TEXT,
  shop_name TEXT, shop_subdomain TEXT, author TEXT,
  price_text TEXT, price_yen INTEGER,
  purchased INTEGER NOT NULL DEFAULT 0, purchased_at TEXT,
  published_at TEXT, category_name TEXT, category_parent TEXT,
  description TEXT, adult INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'inbox',
  rating INTEGER, favorite INTEGER NOT NULL DEFAULT 0, notes TEXT,
  cover_image_id INTEGER REFERENCES item_images(id) ON DELETE RESTRICT,
  compat_declared_count INTEGER,
  id_confidence REAL, id_match_method TEXT,
  source_gone INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  -- 物品分类（v2，用户自己的分类体系，与 BOOTH 自带 category_name/category_parent 是两个维度）
  cat_id TEXT, cat_sub_id TEXT, cat_source TEXT, cat_confidence REAL,
  cat_reason TEXT, cat_evidence TEXT, cat_assigned_at TEXT,
  cat_suggest_id TEXT, cat_suggest_sub_id TEXT, cat_suggest_confidence REAL,
  cat_suggest_reason TEXT, cat_suggest_evidence TEXT, cat_suggest_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_source ON items(source_site, source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_items_status ON items(status);
CREATE INDEX IF NOT EXISTS ix_items_shop ON items(shop_name);
CREATE INDEX IF NOT EXISTS ix_items_updated ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_items_cat ON items(cat_id);
CREATE INDEX IF NOT EXISTS ix_items_cat_sub ON items(cat_sub_id);
CREATE INDEX IF NOT EXISTS ix_items_cat_suggest ON items(cat_suggest_id);

-- 物品分类树（两层：parent_id IS NULL = 主分类）。初始内容由 migrate 从 DEFAULT_TAXONOMY 幂等播种。
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_categories_parent ON categories(parent_id, sort);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  container TEXT NOT NULL,
  path TEXT NOT NULL,
  path_norm TEXT NOT NULL UNIQUE,
  root_id INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE RESTRICT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime TEXT,
  sha256 TEXT,
  sha256_state TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'present',
  discovered_by TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_verified_at TEXT,
  -- v5：深度索引状态（pending|queued|running|partial|done|failed|limited）+ 索引时的内容版本（size:mtime）
  index_state TEXT NOT NULL DEFAULT 'pending',
  index_error TEXT,
  indexed_at TEXT,
  content_version TEXT
);
CREATE INDEX IF NOT EXISTS ix_assets_item ON assets(item_id);
CREATE INDEX IF NOT EXISTS ix_assets_sha ON assets(sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS archive_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  entry_path TEXT NOT NULL,
  entry_size INTEGER NOT NULL DEFAULT 0,
  is_dir INTEGER NOT NULL DEFAULT 0,
  ext TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entries_asset_path ON archive_entries(asset_id, entry_path);

CREATE TABLE IF NOT EXISTS unitypackage_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  type TEXT,
  size INTEGER,
  has_preview INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_upkg_asset_guid ON unitypackage_assets(asset_id, guid);
CREATE INDEX IF NOT EXISTS ix_upkg_path ON unitypackage_assets(asset_path);

-- 去重签名（智能查重）：每个资产一行，结构/GUID/文件哈希三路指纹 + 版本号
CREATE TABLE IF NOT EXISTS asset_signatures (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  file_sha TEXT,
  struct_hash TEXT,
  guid_hash TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0,
  version_key TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sig_struct ON asset_signatures(struct_hash);
CREATE INDEX IF NOT EXISTS ix_sig_guid ON asset_signatures(guid_hash);
CREATE INDEX IF NOT EXISTS ix_sig_sha ON asset_signatures(file_sha);

CREATE TABLE IF NOT EXISTS avatars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'avatar',
  booth_item_id TEXT,
  cover_path TEXT,
  owned INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS avatar_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL UNIQUE,
  lang TEXT,
  source TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS ix_alias_avatar ON avatar_aliases(avatar_id);

CREATE TABLE IF NOT EXISTS item_avatars (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  match TEXT NOT NULL DEFAULT 'any',
  confidence REAL NOT NULL DEFAULT 0,
  evidence TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  PRIMARY KEY (item_id, avatar_id)
);
CREATE INDEX IF NOT EXISTS ix_item_avatars_avatar ON item_avatars(avatar_id);

CREATE TABLE IF NOT EXISTS asset_avatars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
  entry_prefix TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  evidence TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_avatar_prefix ON asset_avatars(asset_id, avatar_id, IFNULL(entry_prefix, ''));

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, namespace TEXT, color TEXT, sort INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_ns_name ON tags(IFNULL(namespace, ''), name);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'manual', query TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, item_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, path TEXT NOT NULL, path_norm TEXT NOT NULL UNIQUE,
  unity_version TEXT, last_scan_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL, note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_proj_item_asset ON project_imports(project_id, item_id, IFNULL(asset_id, 0));

-- 工程**实际引用**（project_imports 是"登记导入"，不代表工程里真的有）
-- 一行 = 一个 GUID 同时出现在某素材包里 + 该工程 Assets/ 下；由 POST /projects/:id/scan-usage 整表替换。
CREATE TABLE IF NOT EXISTS project_refs (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  guid TEXT NOT NULL,
  file_path TEXT,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id, guid)
);
CREATE INDEX IF NOT EXISTS ix_pref_project ON project_refs(project_id);
CREATE INDEX IF NOT EXISTS ix_pref_item ON project_refs(item_id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  -- v6 租约/心跳：只是 jobs 状态机的**辅助元数据**，不新增状态、不改变转移表。
  -- holder=实例身份（host#pid#rand）；lease_until=租约到期（ISO UTC，NULL=旧库未领取）；
  -- lease_token=fencing token（每次领取/接管+1，旧持有者的迟到写入按它被 CAS 拒绝）；heartbeat_at=最近一次续租。
  holder TEXT, lease_until TEXT, lease_token INTEGER NOT NULL DEFAULT 0, heartbeat_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_inflight ON jobs(item_id, kind)
  WHERE item_id IS NOT NULL AND state IN ('queued','resolving','fetching','materializing','indexing','matching','releasing','releasing_done','paused');
CREATE INDEX IF NOT EXISTS ix_jobs_state ON jobs(state, priority DESC, id);
CREATE INDEX IF NOT EXISTS ix_jobs_lease ON jobs(state, lease_until);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, event TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_job_events_job ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS source_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL, provider TEXT NOT NULL,
  json_hash TEXT, files_json TEXT, price_text TEXT, image_urls_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_snapshots_item ON source_snapshots(item_id, id DESC);

CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  detected_at TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_updates_item ON updates(item_id, applied);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'user', action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT
);

-- ===== 扫描变更中心（M1）：持久化预览 + 应用批次 =====
-- 一轮扫描 = 一个 preview：先把「这次会变成什么」落库供确认，用户勾选后再 apply。
-- 只做登记/索引/标记缺失，**不移动、不删除原始文件**，也不自动合并重复项。
CREATE TABLE IF NOT EXISTS scan_previews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  root_id INTEGER REFERENCES library_roots(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  path_norm TEXT NOT NULL,
  deep INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'scanning',
  plan_hash TEXT,
  generator_version INTEGER NOT NULL DEFAULT 1,
  truncated INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  dirs INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT,
  scan_json TEXT,
  error TEXT,
  apply_job_id INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT
);
-- 幂等：同一「根路径 + 深度」同时只允许一个活跃预览（重复创建返回已有的一条）
CREATE UNIQUE INDEX IF NOT EXISTS ux_preview_active ON scan_previews(path_norm, deep)
  WHERE state IN ('scanning','ready','partial','applying');
CREATE INDEX IF NOT EXISTS ix_preview_state ON scan_previews(state, id DESC);

CREATE TABLE IF NOT EXISTS scan_preview_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id INTEGER NOT NULL REFERENCES scan_previews(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  path TEXT NOT NULL,
  path_norm TEXT NOT NULL,
  change TEXT NOT NULL,
  size INTEGER, mtime TEXT,
  prev_size INTEGER, prev_mtime TEXT,
  asset_id INTEGER, item_id INTEGER,
  container TEXT, kind TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  applied INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_preview_item ON scan_preview_items(preview_id, item_key);
CREATE INDEX IF NOT EXISTS ix_preview_item_filter ON scan_preview_items(preview_id, change, id);
CREATE INDEX IF NOT EXISTS ix_preview_item_applied ON scan_preview_items(preview_id, applied);

CREATE TABLE IF NOT EXISTS scan_preview_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id INTEGER NOT NULL REFERENCES scan_previews(id) ON DELETE CASCADE,
  at TEXT NOT NULL, stage TEXT NOT NULL, path TEXT, code TEXT, message TEXT
);
CREATE INDEX IF NOT EXISTS ix_preview_err ON scan_preview_errors(preview_id, id);

CREATE TABLE IF NOT EXISTS scan_apply_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id INTEGER NOT NULL REFERENCES scan_previews(id) ON DELETE CASCADE,
  job_id INTEGER,
  idempotency_key TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  requested INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_apply_idem ON scan_apply_runs(preview_id, IFNULL(idempotency_key,''));
CREATE INDEX IF NOT EXISTS ix_apply_preview ON scan_apply_runs(preview_id, id DESC);

-- ===== 深度索引流水线（v5）=====
-- 一条 = 一个资产的一个处理阶段（hash/archive/unitypackage/thumbs/meta/categorize/fts）。
-- pipeline worker 用 CAS 领取；depends_on 显式表达阶段依赖，避免隐式等待死锁。
CREATE TABLE IF NOT EXISTS index_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  item_id INTEGER,
  stage TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  depends_on INTEGER,
  fingerprint TEXT,
  version_key TEXT,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  items_done INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  next_retry_at TEXT,
  -- v7 租约围栏：owner=领取者实例；lease_token=每次领取/接管+1（旧持有者按它被 CAS 拒绝）；
  -- job_id=顶层作业 id（reap 时按 job 重置其 running 子任务；旧行为 NULL）。
  owner TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER
);
-- 同一资产的同一阶段同时只允许一条活跃任务（排队/运行/等待重试）→ 天然去重
CREATE UNIQUE INDEX IF NOT EXISTS ux_index_task_active ON index_tasks(asset_id, stage)
  WHERE state IN ('queued','running','waiting_retry');
CREATE INDEX IF NOT EXISTS ix_index_task_pick ON index_tasks(state, stage, priority DESC, id);
CREATE INDEX IF NOT EXISTS ix_index_task_asset ON index_tasks(asset_id, stage);
CREATE INDEX IF NOT EXISTS ix_index_task_dep ON index_tasks(depends_on);
CREATE INDEX IF NOT EXISTS ix_index_task_job ON index_tasks(job_id, state);

-- 流水线诊断事件（崩溃恢复、取消、超限降级、缓存命中/失效都留痕；只增不改）
CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  task_id INTEGER,
  asset_id INTEGER,
  item_id INTEGER,
  stage TEXT,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_pipeline_events_at ON pipeline_events(id DESC);
CREATE INDEX IF NOT EXISTS ix_pipeline_events_asset ON pipeline_events(asset_id, id);

-- 派生缓存索引（v5）：缓存本体是 data/cache/<kind>/<key>.json；这里只存元数据，
-- 便于统计命中率、按 LRU 淘汰与"写到一半不算有效"的原子替换审计。
CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_sha TEXT,
  version_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ready',
  -- v6：weak=身份来自 size/mtime 的弱候选（内容未必相同），供缓存诊断/淘汰区分强键与弱键。
  weak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cache_kind ON cache_entries(kind, last_used_at);

-- ===== 容器/资源单元 + 导入计划/执行（v8，工作台）=====
-- asset_units：一个资产内可独立识别的资源单元（unitypackage 本体，或压缩包里的一个 .unitypackage）。
-- mixed 单元仍指向**原始整包**（importable=1，policy=mixed_unitypackage），绝不产生筛选包。
CREATE TABLE IF NOT EXISTS asset_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  item_id INTEGER,
  rel_path TEXT NOT NULL,
  format TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  policy TEXT NOT NULL DEFAULT 'unknown_structure',
  importable INTEGER NOT NULL DEFAULT 0,
  parse_state TEXT NOT NULL DEFAULT 'ok',
  parse_error TEXT,
  avatar_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_id, rel_path)
);
CREATE INDEX IF NOT EXISTS ix_asset_units_item ON asset_units(item_id);
CREATE INDEX IF NOT EXISTS ix_asset_units_policy ON asset_units(policy, importable);

-- 单元之间的关系建议（伴生/变体）；confirmed 只在有显式证据时由上层置位
CREATE TABLE IF NOT EXISTS unit_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_unit_id INTEGER NOT NULL REFERENCES asset_units(id) ON DELETE CASCADE,
  to_unit_id INTEGER NOT NULL REFERENCES asset_units(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  evidence TEXT,
  confidence TEXT NOT NULL DEFAULT 'probable',
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(from_unit_id, to_unit_id, type)
);
CREATE INDEX IF NOT EXISTS ix_unit_relations_to ON unit_relations(to_unit_id);

-- 导入计划：一次"用户确认后要导入 Unity 工程"的快照（含指纹与 precheck）
CREATE TABLE IF NOT EXISTS import_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  project_path TEXT NOT NULL,
  policy TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  user_confirmed INTEGER NOT NULL DEFAULT 0,
  precheck_json TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_import_plans_item ON import_plans(item_id);

-- 计划条目：每单元独立状态；path 永远指向原始资产（整包/原容器），不指向任何筛选产物
CREATE TABLE IF NOT EXISTS import_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL REFERENCES asset_units(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  policy TEXT,
  fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  UNIQUE(plan_id, unit_id)
);
CREATE INDEX IF NOT EXISTS ix_import_plan_items_plan ON import_plan_items(plan_id, status);

-- 执行批次与逐单元状态（import_command_completed 只代表 Unity 接受了命令，验证另算）
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  project_id INTEGER,
  project_path TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  console_errors TEXT,
  summary_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_runs_plan ON import_runs(plan_id, id DESC);

CREATE TABLE IF NOT EXISTS import_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  plan_item_id INTEGER NOT NULL REFERENCES import_plan_items(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  detail_json TEXT,
  UNIQUE(run_id, plan_item_id)
);
CREATE INDEX IF NOT EXISTS ix_import_run_items_run ON import_run_items(run_id, status);

-- 全文检索：trigram 支持中日文子串（>=3 字符走 FTS，<3 字符回退 LIKE）
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, shop_name, author, description, notes, tags_text,
  tokenize='trigram'
);
