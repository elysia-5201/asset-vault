// 造 N 条合成条目用于性能验收（AC8）。用法：node scripts/seed-items.mjs <dbPath> [N]
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const [, , dbPath, nArg] = process.argv;
const N = Number.parseInt(nArg ?? "1000", 10);
if (!dbPath) { console.error("usage: node scripts/seed-items.mjs <dbPath> [N]"); process.exit(2); }
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const now = new Date().toISOString();
const insItem = db.prepare(`INSERT INTO items(uid, source_site, source_item_id, source_url, title, shop_name, author, price_text, price_yen,
  status, adult, favorite, category_name, description, compat_declared_count, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?, 'active', 0, 0, ?, ?, ?, ?, ?)`);
const insImg = db.prepare("INSERT INTO item_images(item_id, role, origin, source_url, file_path, position, created_at) VALUES (?,?,?,?,?,0,?)");
const insAsset = db.prepare(`INSERT INTO assets(item_id, kind, container, path, path_norm, root_id, size, sha256_state, status, discovered_by, first_seen)
  VALUES (?,?,?,?,?,?,?, 'pending', 'present', 'scan', ?)`);
const insFts = db.prepare("INSERT INTO items_fts(rowid, title, shop_name, author, description, notes, tags_text) VALUES (?,?,?,?,?,?,?)");
const avatars = db.prepare("SELECT id, name FROM avatars").all();
const insIA = db.prepare("INSERT OR IGNORE INTO item_avatars(item_id, avatar_id, match, confidence, source) VALUES (?,?, 'any', 1, 'auto')");
const rootRow = db.prepare("SELECT id FROM library_roots LIMIT 1").get() ?? db.prepare("INSERT INTO library_roots(path, path_norm, mode, enabled, created_at) VALUES ('/seed','/seed','index_in_place',1,?) RETURNING id").get(now);

const cats = ["3D衣装", "3D髪型", "3Dテクスチャ", "3D小道具", "3Dモデル"];
const words = ["Shinano", "Manuka", "Milfy", "しなの", "ミルフィ", "Outfit", "Hair", "Texture", "Bunny", "Hoodie"];
const tx = db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const w = words[i % words.length];
    const cat = cats[i % cats.length];
    const title = `${w} sample ${i} ${cat}`;
    const info = insItem.run(randomUUID(), "booth", String(7000000 + i), `https://booth.pm/ja/items/${7000000 + i}`, title, `shop${i % 50}`, `shop${i % 50}`, "¥ 500", 500, cat, `サンプル説明 ${w} 対応`, i % 7 === 0 ? 6 : null, now, now);
    const itemId = Number(info.lastInsertRowid);
    insImg.run(itemId, "cover", "booth", `https://example.invalid/${i}.jpg`, null, now);
    insAsset.run(itemId, "archive", "zip", `/seed/${itemId}.zip`, `/seed/${itemId}.zip`, rootRow.id, 1024 * (i + 1), now);
    insFts.run(itemId, title, `shop${i % 50}`, `shop${i % 50}`, `サンプル説明 ${w} 対応`, "", "");
    const av = avatars[i % avatars.length];
    if (av) insIA.run(itemId, av.id);
  }
});
tx();
const c = db.prepare("SELECT COUNT(*) c FROM items").get().c;
console.log(`seeded: items=${c} (added ${N})`);
db.close();
