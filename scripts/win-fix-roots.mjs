// 迁移收尾：把库里指向已消失路径的 root 清掉，并把资产挂到一个真实存在的目录根上。
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { normalizePath } from "../packages/core/src/pathnorm.ts";

const DB = process.env.ASSETVAULT_DB ?? "%APP_DIR%\\data\\vault.db";
const db = new Database(DB);
db.pragma("journal_mode = WAL");
const now = new Date().toISOString();
const CACHE_ROOT = "%LIBRARY%";

// 1) 确保有一个真实的目录根
let row = db.prepare("SELECT id FROM library_roots WHERE path_norm = ?").get(normalizePath(CACHE_ROOT));
let rootId;
if (row) rootId = row.id;
else rootId = Number(db.prepare("INSERT INTO library_roots(path, path_norm, mode, enabled, created_at) VALUES (?,?, 'index_in_place', 1, ?)").run(CACHE_ROOT, normalizePath(CACHE_ROOT), now).lastInsertRowid);

// 2) 把 <drive>:\game\vrchatcache 下的资产归到这个根
const moved = db.prepare("UPDATE assets SET root_id = ? WHERE path LIKE ? || '%' AND root_id <> ?").run(rootId, CACHE_ROOT, rootId).changes;

// 3) 删掉不存在/是文件的根（先看有没有资产引用，有就一起转到真实根）
const dead = [];
for (const r of db.prepare("SELECT id, path FROM library_roots").all()) {
  if (r.id === rootId) continue;
  let ok = false;
  try { ok = existsSync(r.path) && statSync(r.path).isDirectory(); } catch { ok = false; }
  if (!ok) dead.push(r);
}
for (const r of dead) {
  db.prepare("UPDATE assets SET root_id = ? WHERE root_id = ?").run(rootId, r.id);
  db.prepare("DELETE FROM library_roots WHERE id = ?").run(r.id);
}
console.log(JSON.stringify({ cacheRootId: rootId, assetsMoved: moved, deadRootsRemoved: dead.map((d) => d.path), roots: db.prepare("SELECT id, path FROM library_roots").all() }, null, 2));
db.close();
