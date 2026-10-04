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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_source ON items(source_site, source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_items_status ON items(status);
CREATE INDEX IF NOT EXISTS ix_items_shop ON items(shop_name);
CREATE INDEX IF NOT EXISTS ix_items_updated ON items(updated_at DESC);

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
  last_verified_at TEXT
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

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_inflight ON jobs(item_id, kind)
  WHERE item_id IS NOT NULL AND state IN ('queued','resolving','fetching','materializing','indexing','matching','releasing','releasing_done','paused');
CREATE INDEX IF NOT EXISTS ix_jobs_state ON jobs(state, priority DESC, id);

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

-- 全文检索：trigram 支持中日文子串（>=3 字符走 FTS，<3 字符回退 LIKE）
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, shop_name, author, description, notes, tags_text,
  tokenize='trigram'
);
