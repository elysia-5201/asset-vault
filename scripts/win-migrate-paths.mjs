// 把库里存着的 WSL/Linux 路径改写成 Windows 路径（迁移到 Windows 原生运行时用）。
// 用法（在 <drive>:\tool\asset-vault 下）： node scripts/win-migrate-paths.mjs [--dry]
import Database from "better-sqlite3";
import { normalizePath } from "../packages/core/src/pathnorm.ts";

const dry = process.argv.includes("--dry");
const DB = process.env.ASSETVAULT_DB ?? "%APP_DIR%\\data\\vault.db";

const WSL_ROOT = "<repo>/";
const WIN_ROOT = "%APP_DIR%\\";

export function convert(p) {
  if (typeof p !== "string" || p === "") return p;
  if (p.startsWith("/mnt/") && p.length > 6 && p[5] !== "/") {
    const drive = p[5].toUpperCase();
    return drive + ":\\" + p.slice(7).split("/").join("\\");
  }
  if (p.startsWith(WSL_ROOT)) return WIN_ROOT + p.slice(WSL_ROOT.length).split("/").join("\\");
  if (p.startsWith("/mnt/")) return p.slice(5).replace(/^\//, "").replace(/\//g, "\\");
  return p;
}

const db = new Database(DB);
db.pragma("journal_mode = WAL");
const report = { roots: 0, assets: 0, images: 0, projects: 0, jobs: 0, watches: 0, samples: [] };

const fix = (table, cols, where = "") => {  // 逐行改写（不要提前 return，否则只改第一行）
  const rows = db.prepare(`SELECT rowid AS rid, * FROM ${table} ${where}`).all();
  for (const r of rows) {
    const sets = [], vals = [];
    for (const c of cols) {
      if (typeof r[c] !== "string" || r[c] === "") continue;
      const next = r[c].includes("path_norm") || c.endsWith("_norm") ? normalizePath(convert(r[c])) : convert(r[c]);
      if (next !== r[c]) { sets.push(`${c} = ?`); vals.push(next); if (report.samples.length < 6) report.samples.push(`${table}.${c}: ${r[c]} -> ${next}`); }
    }
    if (sets.length && !dry) db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE rowid = ?`).run(...vals, r.rid);
  }
};
const count = (table, cols) => {
  let n = 0;
  for (const r of db.prepare(`SELECT * FROM ${table}`).all()) {
    for (const c of cols) if (typeof r[c] === "string" && r[c] !== "" && convert(r[c]) !== r[c]) { n++; break; }
  }
  return n;
};
report.roots = count("library_roots", ["path", "path_norm"]);
report.assets = count("assets", ["path", "path_norm"]);
report.images = count("item_images", ["file_path", "thumb_path"]);
report.projects = count("projects", ["path", "path_norm"]);
report.jobs = count("jobs", ["payload"]);
fix("library_roots", ["path", "path_norm"]);
// assets 的 path_norm 是唯一键：先清成临时值避免冲突，再写回
for (const r of db.prepare("SELECT id, path, path_norm FROM assets").all()) {
  const nextPath = convert(r.path), nextNorm = normalizePath(nextPath);
  if (!dry && (nextPath !== r.path || nextNorm !== r.path_norm)) {
    db.prepare("UPDATE assets SET path = ?, path_norm = ? WHERE id = ?").run(nextPath, nextNorm, r.id);
  }
}
fix("item_images", ["file_path", "thumb_path"]);
fix("projects", ["path", "path_norm"]);
for (const j of db.prepare("SELECT id, payload FROM jobs WHERE payload IS NOT NULL").all()) {
  try {
    const before = j.payload;
    const after = before.replace(/\/mnt\/([a-z])\//g, (_m, d) => d.toUpperCase() + ":\\\\").replace(/\/root\/Code\/asset-vault\//g, WIN_ROOT.replace(/\\/g, "\\\\"));
    if (after !== before && !dry) db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(after, j.id);
  } catch { /* 忽略坏 JSON */ }
}
try {
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'watch_paths'").get()?.value;
  if (raw) { const arr = JSON.parse(raw).map((e) => ({ ...e, path: convert(e.path) })); if (!dry) db.prepare("UPDATE settings SET value = ? WHERE key='watch_paths'").run(JSON.stringify(arr)); report.watches = arr.length; }
} catch { /* ignore */ }
console.log(JSON.stringify({ dry, db: DB, report }, null, 2));
db.close();