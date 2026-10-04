/**
 * 内置 mock 种子数据 —— 形状严格对齐 docs/api.md (FROZEN v1) 与 contracts.ts。
 * 仅在 API 不可达时使用（api.ts 探测 /health 失败 → mock 模式）。
 */
import type {
  ArchiveEntry, AssetAvatarRow, AssetRow, AvatarKind, AvatarMatch, ContainerKind,
  ImageOrigin, ImageRole, ImageRow, ItemAvatarRow, ItemRow, ItemStatus, JobEventRow,
  JobKind, JobRow, JobState, LibraryRootRow, RootMode, SourceSite, TagRow, UnityPackageAsset,
} from "@core/contracts";

const NOW = "2026-10-04T02:20:00.000Z";
let seq = 1000;
export const nextId = (): number => ++seq;

/** 离线占位图：内联 SVG data URL（不依赖网络与 /media 端点）。 */
export function svgCover(label: string, hue: number, sub?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const h2 = (hue + 42) % 360;
  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">');
  parts.push('<defs><linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1">');
  parts.push('<stop offset="0" stop-color="hsl(' + hue + ',62%,44%)"/>');
  parts.push('<stop offset="1" stop-color="hsl(' + h2 + ',58%,22%)"/></linearGradient></defs>');
  parts.push('<rect width="480" height="640" fill="url(#g)"/>');
  parts.push('<circle cx="360" cy="120" r="150" fill="rgba(255,255,255,0.08)"/>');
  parts.push('<circle cx="90" cy="520" r="180" fill="rgba(0,0,0,0.18)"/>');
  parts.push('<text x="34" y="560" font-family="sans-serif" font-size="34" font-weight="700" fill="#f2f7ff">' + esc(label.slice(0, 14)) + "</text>");
  if (sub) parts.push('<text x="34" y="596" font-family="sans-serif" font-size="19" fill="rgba(240,248,255,0.72)">' + esc(sub) + "</text>");
  parts.push("</svg>");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(parts.join(""));
}

// ---------------- avatars ----------------
export interface MockAvatarRow {
  id: number; name: string; name_norm: string; kind: AvatarKind; booth_item_id: string | null;
  cover_path: string | null; owned: number; sort: number; created_at: string; updated_at: string;
  aliases: { id: number; alias: string; lang: string | null; source: string }[];
}
export const avatars: MockAvatarRow[] = [
  { id: 1, name: "MANUKA", name_norm: "manuka", kind: "avatar", booth_item_id: "6115428", cover_path: null, owned: 1, sort: 1, created_at: NOW, updated_at: NOW, aliases: [ { id: 11, alias: "まぬか", lang: "ja", source: "booth_tag" }, { id: 12, alias: "マヌカ", lang: "ja", source: "filename" } ] },
  { id: 2, name: "Selestia", name_norm: "selestia", kind: "avatar", booth_item_id: "5086827", cover_path: null, owned: 1, sort: 2, created_at: NOW, updated_at: NOW, aliases: [ { id: 21, alias: "セレスティア", lang: "ja", source: "booth_tag" } ] },
  { id: 3, name: "桔梗", name_norm: "桔梗", kind: "avatar", booth_item_id: "6000001", cover_path: null, owned: 0, sort: 3, created_at: NOW, updated_at: NOW, aliases: [ { id: 31, alias: "Kikyo", lang: null, source: "seed" }, { id: 32, alias: "ききょう", lang: "ja", source: "seed" } ] },
  { id: 4, name: "Shinano", name_norm: "shinano", kind: "avatar", booth_item_id: "6115428", cover_path: null, owned: 1, sort: 4, created_at: NOW, updated_at: NOW, aliases: [ { id: 41, alias: "しなの", lang: "ja", source: "booth_tag" } ] },
  { id: 5, name: "Lime", name_norm: "lime", kind: "avatar", booth_item_id: "5000002", cover_path: null, owned: 1, sort: 5, created_at: NOW, updated_at: NOW, aliases: [ { id: 51, alias: "ライム", lang: "ja", source: "seed" } ] },
  { id: 6, name: "萌", name_norm: "萌", kind: "base", booth_item_id: null, cover_path: null, owned: 0, sort: 6, created_at: NOW, updated_at: NOW, aliases: [ { id: 61, alias: "Moe", lang: null, source: "user" } ] },
];

// ---------------- roots / tags / projects ----------------
export const roots: LibraryRootRow[] = [
  { id: 1, path: "%LIBRARY%/素材库", path_norm: "e:/game/vrchatcache/素材库", mode: "index_in_place", enabled: 1, created_at: NOW },
  { id: 2, path: "%DOWNLOADS%", path_norm: "e:/idm/压缩文件", mode: "index_in_place", enabled: 1, created_at: NOW },
  { id: 3, path: "%LIBRARY%/managed", path_norm: "e:/game/vrchatcache/managed", mode: "managed", enabled: 0, created_at: NOW },
];
export const tags: TagRow[] = [
  { id: 1, name: "衣装", namespace: "kind", color: "#4da3ff", sort: 1 },
  { id: 2, name: "髪型", namespace: "kind", color: "#a97bff", sort: 2 },
  { id: 3, name: "3Dモデル", namespace: "kind", color: "#43c07a", sort: 3 },
  { id: 4, name: "無料", namespace: null, color: "#e0a52e", sort: 4 },
  { id: 5, name: "対応アバター", namespace: null, color: null, sort: 5 },
];
export interface MockProject { id: number; name: string; path: string; created_at: string }
export const projects: MockProject[] = [
  { id: 1, name: "AvatarProject", path: "<drive>:/unity/AvatarProject", created_at: NOW },
];

// ---------------- items ----------------
interface SeedItem {
  title: string; site: SourceSite; sid?: string; shop?: string; author?: string;
  cat?: string; catParent?: string; price?: string; yen?: number; status?: ItemStatus;
  favorite?: number; adult?: number; notes?: string; tagNames?: string[];
  compat?: number; hue: number; images: number; container: "zip" | "7z" | "unitypackage" | "dir" | "none";
  assetCount?: number; purchased?: number; publishedAt?: string; desc?: string;
  compatAvatars?: { id: number; match: AvatarMatch; confidence: number; evidence: string; source: "auto" | "manual" | "confirmed" }[];
}
const seeds: SeedItem[] = [
  { title: "【12アバター対応】セーラー服セット", site: "booth", sid: "6115428", shop: "まぬか屋", author: "まぬか", cat: "衣装", catParent: "3Dモデル", price: "¥1,500", yen: 1500, status: "active", favorite: 1, hue: 210, images: 5, container: "zip", assetCount: 2, compat: 12, purchased: 1, publishedAt: "2025-11-03T00:00:00.000Z", notes: "袖のボーンは要調整。", tagNames: ["衣装", "対応アバター"], desc: "MANUKA / Selestia / 桔梗 など12体対応のセーラー服。", compatAvatars: [ { id: 1, match: "any", confidence: 0.96, evidence: "title:【12アバター対応】| booth_tag:MANUKA", source: "auto" }, { id: 2, match: "any", confidence: 0.91, evidence: "booth_tag:Selestia", source: "auto" }, { id: 3, match: "any", confidence: 0.74, evidence: "archive_path:桔梗/", source: "confirmed" } ] },
  { title: "ロングヘア「ふわり」", site: "booth", sid: "6000001", shop: "Hair Lab", author: "sora", cat: "髪型", catParent: "3Dモデル", price: "¥800", yen: 800, status: "active", hue: 320, images: 4, container: "unitypackage", assetCount: 1, compat: 5, purchased: 1, publishedAt: "2025-08-21T00:00:00.000Z", tagNames: ["髪型"], desc: "物理設定済みのロングヘア。", compatAvatars: [ { id: 1, match: "any", confidence: 0.88, evidence: "unitypackage_path:Assets/Fuwari/", source: "auto" }, { id: 4, match: "any", confidence: 0.66, evidence: "description:しなの対応", source: "auto" } ] },
  { title: "Loli_Shinano_6115428 対応1.01", site: "local", status: "inbox", hue: 160, images: 2, container: "zip", assetCount: 1, compat: 1, tagNames: ["衣装"], compatAvatars: [ { id: 4, match: "any", confidence: 0.93, evidence: "filename:Loli_Shinano_6115428", source: "auto" } ] },
  { title: "[19 Avatars] Oversized Hoodie", site: "gumroad", sid: "hoodie19", shop: "NeonThreads", author: "kuro", cat: "衣装", price: "$12", yen: 1800, status: "inbox", hue: 275, images: 3, container: "zip", assetCount: 1, compat: 19, tagNames: ["衣装"], compatAvatars: [ { id: 2, match: "any", confidence: 0.81, evidence: "title:[19 Avatars]", source: "auto" } ] },
  { title: "Modular Avatar 対応キット", site: "unity_asset_store", sid: "uap-modular", shop: "Unity Technologies", author: "Unity", cat: "ツール", price: "¥0", yen: 0, status: "archived", hue: 30, images: 2, container: "dir", assetCount: 1, tagNames: ["無料"], compatAvatars: [] },
  { title: "【MANUKA専用】サイバーパンク衣装", site: "booth", sid: "7000123", shop: "CyberFit", author: "aki", cat: "衣装", catParent: "3Dモデル", price: "¥2,200", yen: 2200, status: "active", favorite: 1, adult: 1, hue: 190, images: 6, container: "7z", assetCount: 2, compat: 1, purchased: 1, notes: "7z は 7zip-bin 経由のみ。", tagNames: ["衣装", "対応アバター"], compatAvatars: [ { id: 1, match: "all", confidence: 0.99, evidence: "title:【MANUKA専用】| archive_path:MANUKA/", source: "manual" } ] },
  { title: "アクセサリ詰め合わせ Vol.3", site: "booth", sid: "7000555", shop: "小物屋", author: "mio", cat: "アクセサリー", catParent: "3Dモデル", price: "¥500", yen: 500, status: "inbox", hue: 95, images: 3, container: "zip", assetCount: 1, compat: 0, tagNames: [], compatAvatars: [] },
  { title: "Kikyo 用 巫女服", site: "booth", sid: "7000777", shop: "和装屋", author: "yuki", cat: "衣装", catParent: "3Dモデル", price: "¥1,100", yen: 1100, status: "inbox", hue: 350, images: 4, container: "zip", assetCount: 0, compat: 1, tagNames: ["衣装"], compatAvatars: [ { id: 3, match: "any", confidence: 0.87, evidence: "booth_tag:桔梗| title:Kikyo", source: "auto" } ] },
  { title: "汎用シェーダー詰め合わせ", site: "itch", sid: "shader-pack", shop: "ShadeWorks", author: "ren", cat: "シェーダー", price: "¥300", yen: 300, status: "active", hue: 240, images: 2, container: "none", assetCount: 0, tagNames: [], compatAvatars: [] },
  { title: "古い衣装（破損）", site: "booth", sid: "7000999", shop: "旧屋", author: "old", cat: "衣装", status: "trashed", hue: 0, images: 1, container: "none", assetCount: 0, tagNames: [], compatAvatars: [] },
];

export const items: ItemRow[] = [];
export const images: ImageRow[] = [];
export const assets: AssetRow[] = [];
export const itemAvatars: (ItemAvatarRow & { evidence: string | null })[] = [];
export const assetAvatars: AssetAvatarRow[] = [];
export const updates: { id: number; item_id: number; kind: string; detail: string | null; seen: number; created_at: string }[] = [];
export const itemTags = new Map<number, string[]>();
export const archiveEntries = new Map<number, ArchiveEntry[]>();
export const unityPackageAssets = new Map<number, UnityPackageAsset[]>();

const CONTAINER_OF: Record<string, ContainerKind> = { zip: "zip", "7z": "7z", unitypackage: "unitypackage", dir: "dir", none: "file" };
const KIND_OF: Record<string, AssetRow["kind"]> = { zip: "archive", "7z": "archive", unitypackage: "unitypackage", dir: "folder", none: "loose_file" };

function zipEntries(prefix: string, count: number): ArchiveEntry[] {
  const dirs = [prefix + "/", prefix + "/Textures/", prefix + "/Materials/", prefix + "/Prefabs/", prefix + "/Shaders/"];
  const out: ArchiveEntry[] = dirs.map((d) => ({ path: d, size: 0, isDir: true, crc: null }));
  const files: [string, number][] = [];
  for (let i = 0; i < count; i++) {
    const group = i % 4;
    if (group === 0) files.push([prefix + "/Textures/tex_" + String(i).padStart(2, "0") + ".png", 250000 + i * 4096]);
    else if (group === 1) files.push([prefix + "/Materials/mat_" + String(i).padStart(2, "0") + ".mat", 3200 + i * 61]);
    else if (group === 2) files.push([prefix + "/Prefabs/part_" + String(i).padStart(2, "0") + ".prefab", 12000 + i * 97]);
    else files.push([prefix + "/Shaders/toon_" + String(i).padStart(2, "0") + ".shader", 5400 + i * 33]);
  }
  files.push([prefix + "/README.txt", 512]);
  for (const [p, s] of files) out.push({ path: p, size: s, isDir: false, crc: (s * 31) % 65535 });
  return out;
}

function upEntries(prefix: string, count: number): UnityPackageAsset[] {
  const types = ["Prefab", "Material", "Texture2D", "AnimationClip", "Shader", "Mesh"];
  const out: UnityPackageAsset[] = [];
  for (let i = 0; i < count; i++) {
    const t = types[i % types.length];
    const folder = t === "Texture2D" ? "Textures" : t === "Material" ? "Materials" : t === "Prefab" ? "" : t + "s";
    const name = (t === "Prefab" ? "Root_" : t.toLowerCase() + "_") + String(i).padStart(2, "0");
    const ext = t === "Prefab" ? ".prefab" : t === "Material" ? ".mat" : t === "Texture2D" ? ".png" : t === "AnimationClip" ? ".anim" : t === "Shader" ? ".shader" : ".asset";
    out.push({
      guid: (0x100000000000 + i * 7919 + prefix.length).toString(16).padStart(16, "0"),
      assetPath: "Assets/" + prefix + "/" + (folder ? folder + "/" : "") + name + ext,
      type: t, size: t === "Texture2D" ? 180000 + i * 2048 : 4000 + i * 120, hasPreview: i % 3 === 0,
    });
  }
  return out;
}

function build(): void {
  let itemId = 0;
  for (const s of seeds) {
    itemId += 1;
    const id = itemId;
    const createdAt = new Date(Date.UTC(2026, 8, 1, 3, 0, 0) + id * 3600_000).toISOString();
    const row: ItemRow = {
      id, uid: "seed-" + String(id).padStart(3, "0"), source_site: s.site, source_item_id: s.sid ?? null,
      source_url: s.sid && s.site === "booth" ? "https://booth.pm/ja/items/" + s.sid : s.sid && s.site === "gumroad" ? "https://gumroad.com/l/" + s.sid : null,
      canonical_url: null, title: s.title, title_ja: null, shop_name: s.shop ?? null, shop_subdomain: s.shop ? s.shop.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null,
      author: s.author ?? null, price_text: s.price ?? null, price_yen: s.yen ?? null,
      purchased: s.purchased ?? 0, purchased_at: s.purchased ? "2026-01-14T10:00:00.000Z" : null,
      published_at: s.publishedAt ?? null, category_name: s.cat ?? null, category_parent: s.catParent ?? null,
      description: s.desc ?? null, adult: s.adult ?? 0, status: s.status ?? "inbox", rating: s.favorite ? 5 : null,
      favorite: s.favorite ?? 0, notes: s.notes ?? null, cover_image_id: null, compat_declared_count: s.compat ?? null,
      id_confidence: s.site === "booth" ? 0.99 : 0.6, id_match_method: s.site === "booth" ? "url" : "filename",
      source_gone: 0, last_checked_at: "2026-10-01T00:00:00.000Z", created_at: createdAt, updated_at: createdAt,
    };
    // images
    const roles: ImageRole[] = ["cover", "gallery", "gallery", "package_preview", "user"];
    let coverId: number | null = null;
    for (let i = 0; i < s.images; i++) {
      const iid = nextId();
      const role: ImageRole = roles[Math.min(i, roles.length - 1)] ?? "gallery";
      const origin: ImageOrigin = i === 0 ? "booth" : i % 3 === 0 ? "user" : "booth";
      const img: ImageRow = {
        id: iid, item_id: id, role, origin, source_url: s.site === "booth" ? "https://booth.pximg.net/seed/" + id + "/" + i + ".png" : null,
        file_path: origin === "user" ? "%LIBRARY%/素材库/" + id + "/user_" + i + ".png" : null,
        thumb_path: null, width: 480, height: 640, bytes: 120000 + i * 3000,
        sha256: "seed" + String(iid).padStart(58, "0"), position: i, created_at: createdAt,
      };
      images.push(img);
      if (i === 0) { coverId = iid; row.cover_image_id = iid; }
    }
    items.push(row);
    itemTags.set(id, s.tagNames ?? []);
    // compat avatars
    for (const ca of s.compatAvatars ?? []) {
      itemAvatars.push({ item_id: id, avatar_id: ca.id, match: ca.match, confidence: ca.confidence, evidence: ca.evidence, source: ca.source });
    }
    // assets
    const n = s.assetCount ?? 0;
    for (let a = 0; a < n; a++) {
      const aid = nextId();
      const container: ContainerKind = n > 1 && a === 1 ? "dir" : CONTAINER_OF[s.container] ?? "file";
      const kind: AssetRow["kind"] = n > 1 && a === 1 ? "folder" : KIND_OF[s.container] ?? "loose_file";
      const ext = container === "zip" ? ".zip" : container === "7z" ? ".7z" : container === "unitypackage" ? ".unitypackage" : "";
      const path = "%LIBRARY%/素材库/" + id + "/" + (a === 0 ? "pkg" : "extras") + ext;
      const size = container === "unitypackage" ? 91301427 : container === "zip" ? 12_400_000 + a * 300000 : 4_800_000;
      const asset: AssetRow = {
        id: aid, item_id: id, kind, container, path, path_norm: path.toLowerCase(), root_id: 1,
        size, mtime: "2026-09-12T08:30:00.000Z", sha256: container === "file" ? null : "a" + String(aid).padStart(63, "0"),
        sha256_state: "ok", status: "present", discovered_by: "scan", first_seen: createdAt, last_verified_at: "2026-10-01T00:00:00.000Z",
      };
      assets.push(asset);
      if (container === "zip" || container === "7z") archiveEntries.set(aid, zipEntries(a === 0 ? "MANUKA" : "extras", 42 - a * 10));
      if (container === "unitypackage") unityPackageAssets.set(aid, upEntries("MANUKA", 36));
      if (container === "dir") archiveEntries.set(aid, zipEntries("extras", 12));
      // asset-level avatar evidence
      for (const ca of (s.compatAvatars ?? []).slice(0, 1)) {
        assetAvatars.push({ id: nextId(), asset_id: aid, avatar_id: ca.id, entry_prefix: ca.id === 1 ? "MANUKA/" : null, confidence: ca.confidence - 0.05, evidence: "path:" + path + "|prefix:" + (ca.id === 1 ? "MANUKA/" : "n/a") });
      }
    }
    if (id % 4 === 0 && s.status !== "trashed") {
      updates.push({ id: nextId(), item_id: id, kind: "file_changed", detail: "pkg.zip size 12,100,000 → 12,400,000", seen: 0, created_at: "2026-10-02T00:00:00.000Z" });
    }
  }
}
build();

// ---------------- jobs ----------------
export interface MockJobState { job: JobRow; events: JobEventRow[]; frozen: boolean; failOn?: JobState }
export const jobs: MockJobState[] = [];
let jobSeq = 10;

export function addJob(kind: JobKind, itemId: number | null, payload: string | null, state: JobState = "queued", attempts = 0, frozen = false, error: string | null = null): JobRow {
  const id = ++jobSeq;
  const createdAt = new Date(Date.UTC(2026, 9, 4, 2, 0, 0) + id * 60_000).toISOString();
  const job: JobRow = { id, kind, item_id: itemId, payload, state, attempts, priority: 0, error, created_at: createdAt, started_at: state === "queued" ? null : createdAt, finished_at: null };
  const ev: JobEventRow[] = [{ id: nextId(), job_id: id, at: createdAt, from_state: null, to_state: state, event: "start", detail: payload }];
  jobs.push({ job, events: ev, frozen });
  return job;
}

// 覆盖全部状态机状态的演示作业
addJob("import_url", 1, JSON.stringify({ url: "https://booth.pm/ja/items/6115428" }), "done", 1, true);
addJob("import_url", 6, JSON.stringify({ url: "https://booth.pm/ja/items/7000123" }), "fetching", 1, true);
addJob("scan", null, JSON.stringify({ rootId: 1, deep: true }), "paused", 2, true);
addJob("check_update", 3, JSON.stringify({ itemId: 3 }), "failed", 3, true, "UPSTREAM_ERROR: booth.pm 502 (Bad Gateway)");
addJob("reindex", 2, JSON.stringify({ assetId: 4 }), "failed", 5, true, "ARCHIVE_PASSWORD: 需要密码");
addJob("import_file", 5, JSON.stringify({ paths: ["%DOWNLOADS%/ModularAvatar.unitypackage"] }), "cancelled", 1, true);
addJob("match_avatars", 8, JSON.stringify({ itemId: 8 }), "queued", 0, true);
