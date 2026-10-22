import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, readFileSync, statSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { listArchive } from "../../../../packages/core/src/archive/list";
import { listUnityPackage, readUnityPackageAsset } from "../../../../packages/core/src/unitypackage";
import { basename, extname } from "node:path";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { normKey } from "../../../../packages/core/src/contracts";
import { BoothClient, parseBoothUrl } from "../../../../packages/core/src/source/booth";
import { walkCandidates, registerAssets } from "../services/scan";
import { matchItem } from "../services/match";
import { productKeysOf } from "../../../../packages/core/src/related";
import { indexAsset } from "../services/indexing";
import { buildApplyPlan } from "../services/scanpreview";
import { createImportPlan, createImportPlanBatch, confirmImportPlan, getPlanView, precheckImportPlan, getRunView } from "../services/structure";
import type { ItemQuery, Repo } from "../db/repo";
import type { MediaStore } from "../services/media";
import type { JobRunner } from "../jobs/runner";
import { listWatches, setWatches } from "../services/watcher";
import type { InboxWatcher } from "../services/watcher";
import { now, toInt } from "../util";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { parseProtocolUrl, downloadBoothFile, isAllowedBoothUrl } from "../services/download";
import { importBoothUrl } from "../services/booth";
import { UnityMcp, UNITY_MCP_URLS, unityEditorInfo, listUnityPackageCandidates, stageUnityPackage, importPackagesIntoUnity, readUnityConsole, clearUnityConsole, matchAvatarByText, setUnityLogger, baseName, sleep } from "../services/unity";
import { findDuplicatesForItem, listDuplicateGroups, recomputeSignatures } from "../services/dedupe";
import { itemUsage, projectUsage, scanProjectUsage } from "../services/projectusage";
import { relateItems } from "../../../../packages/core/src/related";
import { compareVersions, parseVersion, stripVersionPrefix } from "../../../../packages/core/src/version";
import { evidenceToJson } from "../../../../packages/core/src/categories/classify";
import { applyCategoryEvidence, getCategoryConfig, recommendForItem, reclassifyCategories, setCategoryConfig, suggestTagsFor } from "../services/categories";
import type { IndexPipeline } from "../services/pipeline/pipeline";
import type { DerivedCache } from "../services/pipeline/cache";
import { nonDefaultLimits, resolveLimits, type PipelineLimits } from "../services/pipeline/limits";

export interface RouteDeps {
  repo: Repo; media: MediaStore; booth: BoothClient; runner: JobRunner; watcher?: InboxWatcher;
  log: (m: string) => void; version: string; dbPath: string; dataDir: string;
  /** v0.6.0：后台索引流水线（未取得单写入者锁时为 null） */
  pipeline?: IndexPipeline | null;
  cache?: DerivedCache;
  limits?: PipelineLimits;
}

const DEFAULT_DOWNLOAD_SUBDIR = "downloads";
function downloadRootOf(repo: Repo, dataDir: string): string {
  const saved = repo.getSetting("download_root");
  if (saved && saved.trim()) return saved.trim();
  return join(dataDir, DEFAULT_DOWNLOAD_SUBDIR);
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** 触发分类重跑的元数据字段（§5-4）：只有"分类证据用得到"的字段变了才重跑，纯 UI 开关不算。 */
const CATEGORY_TRIGGER_FIELDS = [
  "title", "title_ja", "titleJa", "description",
  "category_name", "categoryName", "category_parent", "categoryParent",
  "shop_name", "shopName", "author",
] as const;

/** Unity 的 .asset/.mat/.prefab/.anim … 其实都是 YAML 文本，按文本预览才有意义。 */
const UNITY_TEXT_EXT = /\.(txt|md|json|meta|yaml|yml|xml|html?|csv|log|cs|shader|cginc|hlib|hlsl|compute|uss|uxml|asmdef|asmref|inputactions|asset|mat|prefab|anim|controller|unity|preset|physicmaterial|guiskin|mixer|playable|signal|overridecontroller)$/i;
function contentTypeFor(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (UNITY_TEXT_EXT.test(p)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  const err = e as any;
  const status = typeof err?.status === "number" ? err.status : Array.isArray(err?.statusCode) ? 400 : 500;
  const code = err?.code && typeof err.code === "string" ? err.code : status === 500 ? "INTERNAL" : "INVALID_INPUT";
  if (status >= 500) deps_log(String(err?.stack ?? err));
  return reply.status(status).send({ error: { code, message: String(err?.message ?? err) } });
}
let deps_log: (m: string) => void = () => {};

const isTrue = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/** 逗号分隔 / 重复键都接受（`?tags=a,b` 与 `&tags=a&tags=b` 等价）。 */
const csvParam = (v: unknown): string[] =>
  (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]))
    .flatMap((s) => String(s ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * query → ItemQuery：/api/items 与 /api/categories/counts **共用同一个解析器**，
 * 保证「counts.all == items.total」这条自洽性不会因为两处参数漂移而破。
 * v3 新增：tags 多选（tagsMatch=any|all）、favoriteOnly；旧的单个 tag= 保持兼容（同时给出时按 AND 叠加）。
 */
function parseItemQuery(q: any): ItemQuery {
  return {
    q: q.q,
    avatarIds: String(q.avatar ?? "").split(",").map((s) => toInt(s, NaN)).filter((n) => Number.isFinite(n)),
    avatarMatch: q.avatarMatch === "all" ? "all" : "any",
    ownedOnly: isTrue(q.ownedOnly),
    site: q.site, status: q.status, tag: q.tag, container: q.container,
    imported: q.imported === "1" || q.imported === "true" ? true : q.imported === "0" || q.imported === "false" ? false : undefined,
    collectionId: q.collection ? toInt(q.collection, 0) || undefined : undefined,
    categoryIds: csvParam(q.catIds), categoryMatch: q.catMatch === "all" ? "all" : "any",
    uncategorized: isTrue(q.uncategorized),
    pendingCategory: isTrue(q.pendingCategory),
    tagNames: csvParam(q.tags), tagMatch: q.tagsMatch === "all" ? "all" : "any",
    favoriteOnly: isTrue(q.favoriteOnly),
    sort: q.sort === "title" || q.sort === "size" ? q.sort : "updated",
    limit: toInt(q.limit, 60), offset: toInt(q.offset, 0),
  };
}

/** 按 id 取标签行（含 color/sort/itemCount）；取不到给一个形状完整的兜底（绝不 500）。 */
function tagById(repo: Repo, id: number): any {
  const row = (repo.listTags() as any[]).find((t: any) => Number(t.id) === Number(id));
  return row ?? { id, name: "", namespace: null, color: null, sort: 0, itemCount: 0 };
}

// ---------- 检查更新（本机版本 vs GitHub Releases 最新 Release）----------
const DEFAULT_UPDATE_REPO = "elysia-5201/asset-vault";
const UPDATE_REPO_KEY = "update_repo";
const UPDATE_TOKEN_KEY = "update_token";
const UPDATE_CACHE_KEY = "update_last_check";
/** 成功结果缓存 6 小时（force=1 绕过）；**失败不缓存** —— 离线可用性是硬要求。 */
const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 8000;
const UPDATE_NOTES_LIMIT = 2000;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface UpdateCacheEntry { repo: string; checkedAt: string; payload: Record<string, unknown> }

/** settings.update_repo → owner/repo（缺省用内置仓库）；形状不合法返回 ""。 */
function updateRepoSlug(repo: Repo): string {
  const raw = (repo.getSetting(UPDATE_REPO_KEY) ?? "").trim();
  const slug = raw || DEFAULT_UPDATE_REPO;
  return REPO_SLUG_RE.test(slug) ? slug : "";
}

/** 读缓存；形状坏了当没有（不抛）。 */
function readUpdateCache(repo: Repo): UpdateCacheEntry | null {
  try {
    const raw = repo.getSetting(UPDATE_CACHE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as UpdateCacheEntry;
    if (!j || typeof j.repo !== "string" || typeof j.checkedAt !== "string" || !j.payload) return null;
    return j;
  } catch { return null; }
}

/** 抓 GitHub Releases API 的最新 Release（8s 超时）。异常一律抛 Error，由调用方转 ok:false。 */
async function fetchLatestRelease(slug: string, token: string): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPDATE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "user-agent": "AssetVault-UpdateCheck", accept: "application/vnd.github+json" };
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetch("https://api.github.com/repos/" + slug + "/releases/latest", { headers, signal: ac.signal, redirect: "follow" });
    if (!res.ok) {
      if (res.status === 404) throw new Error("仓库或 Release 不存在：" + slug + "（还没发布过 Release？）");
      if (res.status === 403 || res.status === 429) throw new Error("GitHub API 限流（HTTP " + res.status + "）：稍后重试，或配置 settings." + UPDATE_TOKEN_KEY);
      throw new Error("GitHub API HTTP " + res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查更新：**永不抛错、永不 500**。
 * ok:true  → { current, latest, hasUpdate, publishedAt, url, notes, assetName, assetSize, checkedAt, fromCache }
 * ok:false → { error, current, checkedAt }
 */
async function runUpdateCheck(repo: Repo, current: string, force: boolean): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  const failed = (error: string): Record<string, unknown> => ({ ok: false, error, current, checkedAt });
  try {
    if (!parseVersion(current)) return failed("当前应用版本号无法解析：" + String(current));
    const slug = updateRepoSlug(repo);
    if (!slug) return failed("settings." + UPDATE_REPO_KEY + " 形状不合法（应为 owner/repo）：" + (repo.getSetting(UPDATE_REPO_KEY) ?? ""));

    const cached = readUpdateCache(repo);
    if (!force && cached && cached.repo === slug) {
      const age = Date.now() - Date.parse(cached.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < UPDATE_CACHE_TTL_MS) {
        return { ...cached.payload, fromCache: true, checkedAt: cached.checkedAt };
      }
    }

    const rel = await fetchLatestRelease(slug, (repo.getSetting(UPDATE_TOKEN_KEY) ?? "").trim());
    const tag = String(rel?.tag_name ?? "").trim();
    if (!parseVersion(tag)) return failed("Release tag 无法解析为版本号：" + (tag || "(空)"));
    const latest = stripVersionPrefix(tag);
    const assets: any[] = Array.isArray(rel?.assets) ? rel.assets : [];
    // 资产优先挑 portable 包；没有就取第一个
    const asset = assets.find((a) => /portable/i.test(String(a?.name ?? ""))) ?? assets[0] ?? null;
    const payload: Record<string, unknown> = {
      ok: true,
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      publishedAt: typeof rel?.published_at === "string" ? rel.published_at : null,
      url: typeof rel?.html_url === "string" && rel.html_url ? rel.html_url : "https://github.com/" + slug + "/releases/tag/" + tag,
      notes: (typeof rel?.body === "string" ? rel.body : "").slice(0, UPDATE_NOTES_LIMIT),
      assetName: asset ? String(asset.name ?? "") : null,
      assetSize: asset && Number.isFinite(Number(asset.size)) ? Number(asset.size) : null,
      checkedAt,
      fromCache: false,
    };
    try { repo.setSetting(UPDATE_CACHE_KEY, JSON.stringify({ repo: slug, checkedAt, payload })); } catch { /* 缓存写失败不影响本次结果 */ }
    return payload;
  } catch (e) {
    return failed(String((e as any)?.message ?? e));
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  deps_log = deps.log;
  setUnityLogger(deps.log);
  const { repo, media, booth } = deps;

  /** 头像名单（名字 + 别名）——用来把"包名/工程名"认成 avatar。 */
  const avatarLite = () => (repo.listAvatars() as any[]).map((a) => ({ id: Number(a.id), name: String(a.name), aliases: (a.aliases ?? []) as string[] }));
  /** 工程目录名 → avatar（E:\\game\\vrchatcache\\manuka → Manuka）。 */
  const projectAvatarOf = (projectPath?: string | null) => (projectPath ? matchAvatarByText(avatarLite(), String(projectPath)) : null);

  /** Unity 桥端点：settings.unity_mcp_url 优先，否则探测本机两个已知端口。 */
  const unityUrls = (): string[] => {
    const saved = (repo.getSetting("unity_mcp_url") ?? "").trim();
    return saved ? [saved, ...UNITY_MCP_URLS.filter((u) => u !== saved)] : UNITY_MCP_URLS.slice();
  };
  let unityCache: { key: string; client: UnityMcp } | null = null;
  const unity = (): UnityMcp => {
    const urls = unityUrls();
    const key = urls.join(",");
    if (!unityCache || unityCache.key !== key) unityCache = { key, client: new UnityMcp(urls) };
    return unityCache.client;
  };

  // ---------- health ----------
  app.get("/api/health", async () => ({
    ok: true, version: deps.version, dbPath: deps.dbPath,
    roots: repo.listRoots(), counts: repo.stats(),
  }));

  // ---------- items ----------
  app.get("/api/items", async (req, reply) => {
    try {
      // 参数解析统一走 parseItemQuery（与 /api/categories/counts 同一口径）：
      // 关键词/分类(catIds+catMatch)/标签(tags+tagsMatch，或旧的 tag=)/收藏/未分类/待确认/来源/状态/容器/已导入/头像 全部落到真实 SQL。
      return repo.listItems(parseItemQuery(req.query as any));
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/items/:id", async (req, reply) => {
    try {
      const d = repo.getItem(toInt((req.params as any).id, 0));
      if (!d) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      // suggestedTags：自动分类的「建议标签」（契约 §7）——**只读派生**，绝不写 item_tags。本函数永不抛（失败返回 []）。
      // d 已经是一次完整读取：把同一份 detail 交给建议标签，别再让它自己 getItem 一遍（此前一次请求读 3 次）
      return { ...d, updates: repo.listUpdates(d.id), suggestedTags: suggestTagsFor(repo, d.id, 6, d) };
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/items", async (req, reply) => {
    try {
      const b = req.body as any;
      if (!b?.title) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "title 必填" } });
      let sourceSite: any = "local"; let sourceItemId: string | null = null;
      if (b.sourceUrl) { const p = parseBoothUrl(String(b.sourceUrl)); if (p) { sourceSite = "booth"; sourceItemId = p.itemId; } }
      const created = repo.createItem({ title: String(b.title), source_site: sourceSite, source_item_id: sourceItemId, source_url: b.sourceUrl ?? null, notes: b.notes ?? null, status: b.status ?? (sourceItemId ? "active" : "inbox") });
      // §5：手动建档也属于"建档"入口，给一次分类推荐（永不抛，失败不影响建档）
      try { applyCategoryEvidence(repo, created.id, { log: deps.log }); }
      catch (e) { deps.log("category: POST item " + created.id + " 分类失败（已忽略）: " + String((e as any)?.message ?? e)); }
      return repo.getItem(created.id) ?? created;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/api/items/:id", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const body = (req.body ?? {}) as any;
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : null;
      const patch = { ...body };
      delete patch.tags;
      if (Object.keys(patch).length > 0) repo.updateItem(id, patch);
      if (tags) repo.setItemTags(id, tags, "manual");
      // §5-4：元数据变了 → 分类证据也变了，重跑一次（走 applyAutoCategory，manual/confirmed 受保护）。
      // 纯 UI 开关（favorite/status/notes/rating…）不触发。分类失败绝不阻断 PATCH。
      if (CATEGORY_TRIGGER_FIELDS.some((k) => (body as any)[k] !== undefined)) {
        try { applyCategoryEvidence(repo, id, { log: deps.log }); }
        catch (e) { deps.log("category: PATCH item " + id + " 分类失败（已忽略）: " + String((e as any)?.message ?? e)); }
      }
      return repo.getItem(id);
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/items/:id/tags", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const names = ((req.body as any)?.tags ?? []).map(String);
      repo.attachTags(id, names, "manual");
      return repo.getItem(id);
    } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/items/:id/tags/:tagId", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const tagId = toInt((req.params as any).tagId, 0);
      const detail = repo.getItem(id);
      if (!detail) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      // 标签表在真实库里有几百条（596 实测）：循环外取一次，别在 filter 里按条目标签数重复查全表
      const allTags = repo.listTags() as any[];
      const remaining = detail.tags.filter((t) => {
        const [ns, name] = t.includes(":") ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : [null, t];
        const row = allTags.find((x: any) => x.name === name && (x.namespace ?? null) === ns);
        return !row || Number(row.id) !== tagId;
      });
      repo.setItemTags(id, remaining, "manual");
      return repo.getItem(id);
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/items/:id/images/reorder", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const ids = ((req.body as any)?.imageIds ?? []).map((n: any) => toInt(n, 0)).filter(Boolean);
      repo.reorderImages(id, ids);
      return repo.getItem(id);
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/api/items/:id", async (req, reply) => {
    try { return repo.updateItem(toInt((req.params as any).id, 0), { status: "trashed" }); }
    catch (e) { return fail(reply, e); }
  });
  app.post("/api/items/:id/restore", async (req, reply) => {
    try { return repo.updateItem(toInt((req.params as any).id, 0), { status: "active" }); }
    catch (e) { return fail(reply, e); }
  });

  app.post("/api/items/:id/images", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      const b = (req.body ?? {}) as any;
      const added = [];
      if (Array.isArray(b.paths)) {
        for (const p of b.paths) {
          const st = statSync(String(p));
          if (!st.isFile()) continue;
          const ext = extname(String(p)).toLowerCase();
          if (!IMAGE_EXT.has(ext) && !IMAGE_EXT.has("." + ext)) continue;
          const saved = await media.saveImage(itemId, readFileSync(String(p)), ext.slice(1));
          added.push(repo.addImage(itemId, { role: "user", origin: "user", file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256 }));
        }
      }
      if (b.url) {
        const r = await booth.fetchImage(String(b.url));
        const saved = await media.saveImage(itemId, r.bytes, "jpg");
        added.push(repo.addImage(itemId, { role: "user", origin: "user", source_url: String(b.url), file_path: saved.filePath, thumb_path: saved.thumbPath, width: saved.width, height: saved.height, bytes: saved.bytes, sha256: saved.sha256 }));
      }
      // 手工导入的图默认接管封面：否则"刚导入新图，卡片还是老图"，看起来像没更新。
      // 传 setCover:false 可关闭；随时可用详情页的「封面」按钮改回去。
      if (added.length > 0 && b.setCover !== false) repo.setCover(itemId, added[0]!.id);
      return added;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/api/items/:id/images/:imageId", async (req, reply) => {
    try { repo.deleteImage(toInt((req.params as any).id, 0), toInt((req.params as any).imageId, 0)); return { ok: true }; }
    catch (e) { return fail(reply, e); }
  });
  app.post("/api/items/:id/images/:imageId/cover", async (req, reply) => {
    try { repo.setCover(toInt((req.params as any).id, 0), toInt((req.params as any).imageId, 0)); return repo.getItem(toInt((req.params as any).id, 0)); }
    catch (e) { return fail(reply, e); }
  });

  app.post("/api/items/:id/assets", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      const p = String((req.body as any)?.path ?? "");
      if (!p) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "path 必填" } });
      const st = statSync(p);
      const rootRow = repo.listRoots()[0] ?? repo.ensureRoot(p, "index_in_place");
      const added: number[] = [];
      if (st.isDirectory()) {
        const stats = await walkCandidates(p, { maxDepth: 4 });
        for (const f of stats.filesOut) { const r = registerAssets(repo, (rootRow as any).id, p, itemId, f, "manual"); if (r.created) added.push(r.id); }
      } else {
        const container = (extname(p).slice(1).toLowerCase() || "file") as any;
        const r = repo.upsertAsset({ item_id: itemId, kind: container === "unitypackage" ? "unitypackage" : "archive", container, path: p, path_norm: normalizePath(p), root_id: (rootRow as any).id, size: st.size, mtime: st.mtime.toISOString(), discovered_by: "manual" });
        if (r.created) added.push(r.asset.id);
      }
      for (const id of added) repo.createJob("reindex", itemId, { assetId: id }, 5);
      return { added: added.length, assetIds: added };
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/items/:id/avatars", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      const b = (req.body ?? {}) as any;
      const ids = (b.avatarIds ?? []).map((n: any) => toInt(n, NaN)).filter((n: number) => Number.isFinite(n));
      repo.setItemAvatars(itemId, ids, "manual", b.match ?? "any", 1);
      return repo.listItemAvatars(itemId);
    } catch (e) { return fail(reply, e); }
  });
  /**
   * 按素材内容校正适配模型：只保留有**包内证据**（archive_path / unitypackage_path / filename）的，
   * 去掉只在商品页标题/标签/描述里出现过的。
   * 起因：BOOTH 卖家会把「本商品支持的全部 bases」都打上 tag（实测一个只有 Shinano 变体的纹身素材，
   * tags 里有 セレスティア/しなの/萌/愛莉/シフォン/マヌカ/Sio…），于是匹配出一堆 0.93 的假适配。
   */
  app.post("/api/items/:id/avatars/prune", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      if (!repo.getItem(itemId)) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      const FILE_SOURCES = ["archive_path", "unitypackage_path", "filename"];
      const rows = repo.listItemAvatars(itemId) as any[];
      const parsed = rows.map((a) => {
        let sources: string[] = [];
        try { const j = JSON.parse(String(a.evidence ?? "")); if (Array.isArray(j.sources)) sources = j.sources.map((s: any) => String(s)); } catch { /* 证据不是 JSON 就没有 sources */ }
        return { id: Number(a.avatar_id), name: String(a.name ?? ""), sources, fileEvidence: sources.some((s) => FILE_SOURCES.includes(s)) };
      });
      if (!parsed.some((p) => p.fileEvidence)) {
        return { ok: true, removed: [], kept: parsed.map((p) => p.name), note: "没有任何适配模型有包内证据，无从校正（先跑一次重跑头像匹配）" };
      }
      const drop = parsed.filter((p) => !p.fileEvidence);
      for (const d of drop) repo.removeItemAvatar(itemId, d.id);
      deps.log("prune avatars: item " + itemId + " removed=" + drop.map((d) => d.name).join(",") + " kept=" + parsed.filter((p) => p.fileEvidence).map((p) => p.name).join(","));
      return {
        ok: true,
        removed: drop.map((d) => ({ id: d.id, name: d.name, sources: d.sources })),
        kept: parsed.filter((p) => p.fileEvidence).map((p) => p.name),
      };
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/api/items/:id/avatars/:avatarId", async (req, reply) => {
    try { repo.removeItemAvatar(toInt((req.params as any).id, 0), toInt((req.params as any).avatarId, 0)); return { ok: true }; }
    catch (e) { return fail(reply, e); }
  });
  /** 把已有的（通常是扫库建出来的）本地条目关联到 BOOTH 商品：补标题/店铺/价格/分类/标签 + 抓图集。 */
  app.post("/api/items/:id/link-booth", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const b = (req.body ?? {}) as any;
      const url = String(b?.url ?? "");
      if (!url) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "url 必填" } });
      const out = await importBoothUrl(repo, media, booth, url, { targetItemId: id, onConflict: b.merge ? "merge" : "error" });
      const matched = await matchItem(repo, out.itemId, {});
      deps.log("link-booth: item " + id + " -> booth " + out.meta.itemId + " images=" + out.images + " avatars+" + matched.addedItem);
      return { ...out, matched };
    } catch (e) {
      const err = e as any;
      if (err?.conflictItemId) {
        return reply.status(409).send({ error: { code: "CONFLICT", message: err.message, conflictItemId: err.conflictItemId } });
      }
      return fail(reply, e);
    }
  });

  app.post("/api/items/:id/match-avatars", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      const outcome = await matchItem(repo, itemId, {});
      return outcome;
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/items/:id/check-update", async (req, reply) => {
    try { const j = repo.createJob("check_update", toInt((req.params as any).id, 0), { url: null }, 5); return { jobId: j.id, state: j.state }; }
    catch (e) { return fail(reply, e); }
  });

  // ---------- assets ----------
  app.get("/api/assets/:id", async (req, reply) => {
    try {
      const a = repo.getAsset(toInt((req.params as any).id, 0));
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      return { asset: a, avatars: repo.listAssetAvatars(a.id) };
    } catch (e) { return fail(reply, e); }
  });
  /**
   * 列压缩包目录；?nested=<包内路径> 时列**内层压缩包**的目录（懒展开，避免一次解出所有内层包）。
   * 很多 VRChat 素材是"一个 zip 里 N 个 per-avatar zip / 一个 zip 里放着 unitypackage"，只列外层等于没看到内容。
   */
  app.get("/api/assets/:id/tree", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      const nestedPath = String((req.query as any).nested ?? "");
      if (nestedPath) {
        const { readArchiveEntry } = await import("../../../../packages/core/src/archive/list");
        const tmp = join(tmpdir(), "av-nested-tree-" + process.pid + "-" + Date.now() + "-" + baseName(nestedPath).replace(/[^\w.\-]+/g, "_"));
        try {
          writeFileSync(tmp, await readArchiveEntry(a.path, nestedPath, 2 * 1024 * 1024 * 1024));
          const listing = await listArchive(tmp, { maxEntries: 20000 });
          return { container: "nested" as const, path: nestedPath, entries: listing.entries, truncated: listing.truncated, passwordProtected: listing.passwordProtected, cached: false };
        } finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
      }
      let entries = repo.getArchiveEntries(id);
      if (entries.length === 0 && a.container !== "unitypackage") {
        const { listArchive } = await import("../../../../packages/core/src/archive/list");
        const listing = await listArchive(a.path, { maxEntries: 20000 });
        repo.replaceArchiveEntries(id, listing.entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir })));
        entries = repo.getArchiveEntries(id);
      }
      return { container: a.container, path: a.path, entries, cached: true };
    } catch (e) { return fail(reply, e); }
  });
  /**
   * unitypackage 里的资产清单。
   * 压缩包（zip/7z/rar）里的 unitypackage 也算 —— 发现逻辑与"导入 Unity"完全同一套
   * （含 per-avatar zip、zip 套 zip），否则"包里明明有 1.6MB 的 .unitypackage，这一栏却是 0"。
   */
  app.get("/api/assets/:id/unitypackage", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      let assets: any[] = [];
      const packages: { label: string; source: string; size: number; assets: number; note?: string }[] = [];

      if (a.container === "unitypackage") {
        assets = repo.getUnityPackageAssets(id);
        if (!assets.length) {
          const listing = await listUnityPackage(a.path, { maxAssets: 20000 });
          repo.replaceUnityPackageAssets(id, listing.assets);
          assets = repo.getUnityPackageAssets(id);
        }
        packages.push({ label: baseName(a.path), source: a.path, size: a.size, assets: assets.length });
      } else if (a.container === "zip" || a.container === "7z" || a.container === "rar") {
        const found = (await listUnityPackageCandidates(repo, a.item_id)).packages.filter((c) => c.assetId === id).slice(0, 6);
        if (found.length) {
          const stagingDir = join(deps.dataDir, "unity-staging");
          const idx = new Map<string, { pkgFile: string; guid: string }>();
          for (const c of found) {
            const src = c.innerEntryPath ? c.entryPath + " › " + c.innerEntryPath : (c.entryPath ?? a.path);
            try {
              const staged = await stageUnityPackage(c, stagingDir);
              const listing = await listUnityPackage(staged.path, { maxAssets: 20000 });
              packages.push({ label: c.label, source: src, size: c.size, assets: listing.assets.length, note: c.note });
              for (const x of listing.assets) {
                assets.push({ ...x, package: c.label });
                idx.set(String(x.assetPath), { pkgFile: staged.path, guid: String(x.guid) });
              }
            } catch { packages.push({ label: c.label, source: src, size: c.size, assets: 0 }); }
          }
          if (assets.length > 20000) assets = assets.slice(0, 20000);
          if (idx.size) { upkgIndex.set(id, idx); }   // 预览直接复用，不用再解一次
        }
      }

      const byType: Record<string, number> = {};
      for (const x of assets) { const t = (x.type as string) || "other"; byType[t] = (byType[t] ?? 0) + 1; }
      return { assets, total: assets.length, byType, packages, container: a.container };
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/assets/:id/entry", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const p = String((req.query as any).path ?? "");
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      if (!p) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "path 必填" } });
      const ct = contentTypeFor(p);
      // unitypackage 里是 <guid>/asset 的 tar 结构：先按 pathname 反查 guid 再读（本体与压缩包里的都支持）
      if (a.container === "unitypackage" || a.container === "zip" || a.container === "7z" || a.container === "rar") {
        const idx = await upkgIndexFor(id, a.item_id);
        const hit = idx.get(p);
        if (hit) {
          const buf = await readUnityPackageAsset(hit.pkgFile, hit.guid, 64 * 1024 * 1024);
          if (buf) return reply.header("content-type", ct).send(buf);
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "包里没有这个文件（guid " + hit.guid.slice(0, 8) + " 缺少 asset 条目）" } });
        }
      }
      const { readArchiveEntry } = await import("../../../../packages/core/src/archive/list");
      const buf = await readArchiveEntry(a.path, p, 16 * 1024 * 1024);
      return reply.header("content-type", ct).send(buf);
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/assets/:id/reindex", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      const r = await indexAsset(repo, media, id, { hashMaxBytes: 8 * 1024 * 1024 * 1024 });
      await matchItem(repo, a.item_id, {});
      return r;
    } catch (e) { return fail(reply, e); }
  });

  // ---------- avatars ----------
  app.get("/api/avatars", async (req, reply) => {
    try {
      const q = req.query as any;
      return { avatars: repo.listAvatars({ ownedOnly: q.ownedOnly === "1" || q.ownedOnly === "true", q: q.q }) };
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/avatars/:id", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const av = repo.getAvatar(id);
      if (!av) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "avatar 不存在" } });
      const q = req.query as any;
      const ids = [id];
      const items = repo.listItems({ avatarIds: ids, avatarMatch: "any", limit: toInt(q.limit, 60), offset: toInt(q.offset, 0), sort: "updated" });
      return { avatar: av, aliases: repo.listAliases(id), ...items };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/avatars", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      if (!b?.name) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "name 必填" } });
      const existing = repo.findAvatarByAlias(String(b.name).toLowerCase().replace(/[\s\u3000·・.,]/g, ""));
      if (existing && !b.force) return reply.status(409).send({ error: { code: "CONFLICT", message: `已存在同名/同别名 avatar: ${existing.name}` } });
      return repo.createAvatar({ name: String(b.name), kind: b.kind, owned: !!b.owned, boothItemId: b.boothItemId ?? null, aliases: b.aliases });
    } catch (e) { return fail(reply, e); }
  });
  app.patch("/api/avatars/:id", async (req, reply) => {
    try { return repo.updateAvatar(toInt((req.params as any).id, 0), (req.body ?? {}) as any); }
    catch (e) { return fail(reply, e); }
  });
  app.delete("/api/avatars/:id", async (req, reply) => {
    try { repo.deleteAvatar(toInt((req.params as any).id, 0)); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.post("/api/avatars/:id/aliases", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const b = (req.body ?? {}) as any;
      if (!b?.alias) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "alias 必填" } });
      try { return repo.addAlias(id, String(b.alias), b.lang ?? null, b.source ?? "user"); }
      catch (err: any) {
        if (String(err?.message ?? "").includes("UNIQUE")) {
          const other = repo.findAvatarByAlias(String(b.alias).normalize("NFKC").toLowerCase().replace(/[\s\u3000·・.,]/g, ""));
          return reply.status(409).send({ error: { code: "CONFLICT", message: `别名已被 ${other?.name ?? "其他"} 占用（待确认，不静默合并）` } });
        }
        throw err;
      }
    } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/avatars/:id/aliases/:aliasId", async (req, reply) => {
    try { repo.deleteAlias(toInt((req.params as any).id, 0), toInt((req.params as any).aliasId, 0)); return { ok: true }; }
    catch (e) { return fail(reply, e); }
  });
  app.post("/api/avatars/merge", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const fromId = toInt(b.fromId, 0), intoId = toInt(b.intoId, 0);
      if (!fromId || !intoId || fromId === intoId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "fromId/intoId 非法" } });
      repo.mergeAvatars(fromId, intoId);
      return repo.getAvatar(intoId);
    } catch (e) { return fail(reply, e); }
  });

  // ---------- booth / import / scan ----------
  app.get("/api/booth/peek", async (req, reply) => {
    try {
      const url = String((req.query as any).url ?? "");
      const parsed = parseBoothUrl(url);
      if (!parsed) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "不是有效的 BOOTH 链接" } });
      const meta = await booth.fetchItem(parsed.itemId);
      return {
        itemId: meta.itemId, title: meta.title, shop: meta.shop, priceText: meta.priceText, isAdult: meta.isAdult,
        category: meta.category, tags: meta.tags.map((t) => t.name), images: meta.images.slice(0, 12).map((i) => i.original),
        files: meta.variations.flatMap((v) => v.files.map((f) => ({ name: f.name, size: f.file_size ?? null }))),
        description: (meta.description ?? "").slice(0, 2000), canonicalUrl: parsed.canonicalUrl,
      };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/import/url", async (req, reply) => {
    try {
      const url = String((req.body as any)?.url ?? "");
      const j = repo.createJob("import_url", null, { url }, 10);
      return { jobId: j.id, state: j.state };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/import/paths", async (req, reply) => {
    try {
      const paths: string[] = ((req.body as any)?.paths ?? []).map(String);
      const jobs = paths.map((p) => repo.createJob("import_file", null, { path: p }, 5));
      return { jobIds: jobs.map((j) => j.id) };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/scan", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const rootRow = b.rootId ? (repo.listRoots() as any[]).find((r) => r.id === toInt(b.rootId, 0)) : null;
      const p = b.path ?? rootRow?.path;
      if (!p) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "需要 rootId 或 path" } });
      if (b.dryRun) {
        const { planFromFiles } = await import("../services/scan");
        const stats = await walkCandidates(String(p), { maxDepth: b.deep ? 10 : 6 });
        const plans = planFromFiles(String(p), stats.filesOut);
        // M0/P1：只读预览也把扫描完整性暴露出来（向后兼容——老字段全部保留，新增字段仅供判断"这轮看全了没有"）。
        return { dryRun: true, path: p, files: stats.files, dirs: stats.dirs, bytes: stats.bytes, truncated: stats.truncated,
          complete: stats.complete, errorCount: stats.errorCount, readability: stats.readability, errors: stats.errors,
          items: plans.map((x) => ({ title: x.title, sourceSite: x.sourceSite, sourceItemId: x.sourceItemId, confidence: x.confidence, assets: x.assets.length })) };
      }
      const j = repo.createJob("scan", null, { path: p, rootId: rootRow?.id ?? null, deep: !!b.deep }, 3);
      return { jobId: j.id, state: j.state };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 扫描变更中心（M1）：持久化预览 ----------
  // 预览 = 一轮扫描的"会发生什么"快照；确认后 apply 只做 登记新文件 / 重索引变化文件 / 标记确认缺失，
  // 不移动、不删除原始文件，也不自动合并重复项。设计见 docs/scan-preview.md。
  const previewView = (p: any) => ({
    ...p,
    counts: p.counts_json ? JSON.parse(p.counts_json) : null,
    scan: p.scan_json ? JSON.parse(p.scan_json) : null,
    itemCounts: repo.scanPreviewItemCounts(p.id),
  });
  const previewOr404 = (id: number) => {
    const p = repo.getScanPreview(id);
    if (!p) return null;
    return p;
  };

  app.post("/api/scan/previews", async (req, reply) => {
    try {
      repo.expireScanPreviews(); // FIX-01：先清扫过期/失联的 scanning，避免复用一个永远 scanning 的旧预览
      const b = (req.body ?? {}) as any;
      const rootRow = b.rootId ? (repo.listRoots() as any[]).find((r) => r.id === toInt(b.rootId, 0)) : null;
      const path = String(b.path ?? rootRow?.path ?? "").trim();
      if (!path) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "需要 rootId 或 path" } });
      const deep = !!b.deep;
      const prior = repo.findActiveScanPreview(normalizePath(path), deep);
      const preview = repo.createScanPreview({ rootId: rootRow?.id ?? null, path, deep });
      if (prior) return { previewId: preview.id, state: preview.state, existing: true };
      const job = repo.createJob("scan", null, { mode: "preview", previewId: preview.id, path: preview.path, rootId: preview.root_id, deep }, 3);
      return reply.status(202).send({ previewId: preview.id, state: preview.state, jobId: job.id, existing: false });
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/scan/previews", async (req, reply) => {
    try {
      repo.expireScanPreviews();
      const q = req.query as any;
      return { previews: (repo.listScanPreviews(toInt(q.limit, 50)) as any[]).map(previewView) };
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/scan/previews/:id", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      return {
        preview: previewView(p),
        applies: repo.listScanApplyRuns(id),
        errors: repo.listScanPreviewErrors(id, 100),
      };
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/scan/previews/:id/items", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      const q = req.query as any;
      const page = repo.listScanPreviewItems(id, { cursor: toInt(q.cursor, 0) || undefined, limit: toInt(q.limit, 100), change: q.change ? String(q.change) : undefined });
      return { previewId: id, state: p.state, items: page.items, nextCursor: page.nextCursor, counts: repo.countScanPreviewItems(id), itemCounts: repo.scanPreviewItemCounts(id) };
    } catch (e) { return fail(reply, e); }
  });

  /** 勾选/取消：{keys:[path_norm...], decision:'accept'|'skip'|'pending'} 或 {change:'new', decision} 批量按类型。 */
  app.post("/api/scan/previews/:id/items", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      if (!["ready", "partial"].includes(p.state)) return reply.status(409).send({ error: { code: "PREVIEW_NOT_READY", message: "预览当前状态不可修改: " + p.state } });
      const b = (req.body ?? {}) as any;
      const decision = b.decision === "skip" ? "skip" : b.decision === "pending" ? "pending" : "accept";
      let keys: string[] = Array.isArray(b.keys) ? b.keys.map(String) : [];
      if (keys.length === 0 && b.change) {
        const rows = repo.listScanPreviewItems(id, { limit: 500, change: String(b.change) });
        keys = rows.items.map((x: any) => x.item_key);
      }
      const changed = repo.setScanPreviewDecisions(id, keys, decision);
      return { updated: changed, itemCounts: repo.scanPreviewItemCounts(id) };
    } catch (e) { return fail(reply, e); }
  });

  /** 应用：可带 planHash（过期即 409）、idempotencyKey（重复提交返回同一批次）。 */
  app.post("/api/scan/previews/:id/apply", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      repo.expireScanPreviews();
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      if (p.state === "applying") return reply.status(409).send({ error: { code: "PREVIEW_NOT_READY", message: "该预览正在应用中" } });
      if (!["ready", "partial"].includes(p.state)) return reply.status(409).send({ error: { code: "PREVIEW_NOT_READY", message: "预览当前状态不可应用: " + p.state } });
      if (p.expires_at && p.expires_at < now()) { repo.updateScanPreview(id, { state: "expired", finished_at: now() }); return reply.status(410).send({ error: { code: "PREVIEW_EXPIRED", message: "预览已过期，请重新扫描" } }); }
      const b = (req.body ?? {}) as any;
      if (b.planHash && p.plan_hash && String(b.planHash) !== String(p.plan_hash)) {
        return reply.status(409).send({ error: { code: "STALE_PREVIEW", message: "预览内容已变化（planHash 不一致），请重新扫描" } });
      }
      const idem = b.idempotencyKey ? String(b.idempotencyKey) : null;
      if (idem) { const run = repo.findScanApplyRunByKey(id, idem); if (run) return { previewId: id, applyRunId: run.id, jobId: run.job_id, existing: true }; }
      if (b.mode === "all") {
        const rows = repo.listScanPreviewItems(id, { limit: 500 });
        const keys = rows.items.filter((x: any) => ["new", "changed", "duplicate_suspected", "missing"].includes(x.change)).map((x: any) => x.item_key);
        repo.setScanPreviewDecisions(id, keys, "accept");
      } else if (Array.isArray(b.itemKeys) && b.itemKeys.length) {
        repo.setScanPreviewDecisions(id, b.itemKeys.map(String), "accept");
      }
      const plan = buildApplyPlan(repo, id);
      for (const s of plan.stale) repo.setScanPreviewItemResult(s.id, false, "stale: " + s.reason);
      if (plan.files.length === 0 && plan.missingIds.length === 0) {
        return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "没有可应用的条目（未勾选、或全部因文件变化而过期）", stale: plan.stale.length } });
      }
      const run = repo.createScanApplyRun({ previewId: id, idempotencyKey: idem, requested: plan.requested });
      const job = repo.createJob("scan", null, {
        mode: "apply", previewId: id, applyRunId: run.id, path: p.path, rootId: p.root_id, deep: !!p.deep,
        files: plan.files, markMissing: plan.missingIds, applyItems: plan.items, staleCount: plan.stale.length,
      }, 5);
      repo.updateScanApplyRun(run.id, { job_id: job.id });
      repo.updateScanPreview(id, { state: "applying", apply_job_id: job.id });
      return reply.status(202).send({ previewId: id, applyRunId: run.id, jobId: job.id, files: plan.files.length, missing: plan.missingIds.length, stale: plan.stale.length, requested: plan.requested });
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/scan/previews/:id/cancel", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      repo.expireScanPreviews();
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      if (p.state === "applying") return reply.status(409).send({ error: { code: "CONFLICT", message: "应用已开始，无法取消（可对失败项重试）" } });
      if (!["ready", "partial", "scanning"].includes(p.state)) return reply.status(409).send({ error: { code: "CONFLICT", message: "当前状态不可取消: " + p.state } });
      // FIX-01：取消生成中的 job（payload.previewId），再 CAS 预览 → cancelled。
      // 即使 job 已并发完成/暂停导致转移失败，预览 CAS 也会让生成器迟到的结果整体丢弃。
      const active = repo.findActiveJobByPreview(id);
      if (active) {
        try {
          const afterStop = repo.transitionJob(active.id, "stop");
          if (afterStop.state === "releasing") repo.transitionJob(active.id, "cancel_apply");
        } catch { /* 并发状态变化：忽略，预览 CAS 兜底 */ }
      }
      const updated = repo.updateScanPreviewIf(id, ["scanning", "ready", "partial"], { state: "cancelled", finished_at: now() });
      return { preview: previewView(updated ?? repo.getScanPreview(id)) };
    } catch (e) { return fail(reply, e); }
  });

  /** 重试：把失败/未应用项重新勾选后走同一套 apply（已成功项不会重复写入）。 */
  app.post("/api/scan/previews/:id/retry", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      repo.expireScanPreviews();
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      // FIX-01 门禁：只允许 ready/partial（applying 且 job 已死会被上面的 sweep 变成 failed，不可重试）
      if (!["ready", "partial"].includes(p.state)) {
        return reply.status(409).send({ error: { code: "PREVIEW_NOT_READY", message: "当前状态不可重试: " + p.state } });
      }
      const rows = repo.listScanPreviewItems(id, { limit: 500 });
      const keys = rows.items.filter((x: any) => x.applied === 0 && x.error && ["new", "changed", "duplicate_suspected", "missing"].includes(x.change)).map((x: any) => x.item_key);
      if (keys.length === 0) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "没有可重试的条目" } });
      repo.setScanPreviewDecisions(id, keys, "accept");
      const plan = buildApplyPlan(repo, id);
      for (const s of plan.stale) repo.setScanPreviewItemResult(s.id, false, "stale: " + s.reason);
      if (plan.files.length === 0 && plan.missingIds.length === 0) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "可重试的条目都已过期（文件变化），请重新扫描" } });
      const run = repo.createScanApplyRun({ previewId: id, idempotencyKey: null, requested: plan.requested });
      const job = repo.createJob("scan", null, {
        mode: "apply", previewId: id, applyRunId: run.id, path: p.path, rootId: p.root_id, deep: !!p.deep,
        files: plan.files, markMissing: plan.missingIds, applyItems: plan.items, staleCount: plan.stale.length,
      }, 5);
      repo.updateScanApplyRun(run.id, { job_id: job.id });
      repo.updateScanPreview(id, { state: "applying", apply_job_id: job.id });
      return reply.status(202).send({ previewId: id, applyRunId: run.id, jobId: job.id, files: plan.files.length, missing: plan.missingIds.length, stale: plan.stale.length, requested: plan.requested, retried: keys.length });
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/api/scan/previews/:id", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      repo.expireScanPreviews();
      const p = previewOr404(id);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "预览不存在" } });
      // FIX-01：applying 只有在 apply job 仍活着时才禁止删除；job 已死（sweep 之前的状态）允许清理
      if (p.state === "applying" && repo.isJobActive(p.apply_job_id)) {
        return reply.status(409).send({ error: { code: "CONFLICT", message: "应用进行中，不能删除预览" } });
      }
      return { deleted: repo.deleteScanPreview(id) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- jobs ----------
  app.get("/api/jobs", async (req, reply) => {
    try { const q = req.query as any; return { jobs: repo.listJobs(q.state, toInt(q.limit, 100)) }; } catch (e) { return fail(reply, e); }
  });
  app.get("/api/jobs/:id/events", async (req, reply) => {
    try { return { events: repo.listJobEvents(toInt((req.params as any).id, 0)) }; } catch (e) { return fail(reply, e); }
  });
  for (const [action, event] of [["pause", "stop"], ["cancel", "stop"], ["retry", "retry"], ["abandon", "abandon"]] as const) {
    app.post(`/api/jobs/:id/${action}`, async (req, reply) => {
      try {
        const id = toInt((req.params as any).id, 0);
        if (action === "pause") {
          const j = repo.transitionJob(id, "stop");
          return j.state === "releasing" ? repo.transitionJob(id, "hold") : j;
        }
        if (action === "cancel") {
          const j = repo.transitionJob(id, "stop");
          return j.state === "releasing" ? repo.transitionJob(id, "cancel_apply") : j;
        }
        return repo.transitionJob(id, event as any);
      } catch (e) { return fail(reply, e); }
    });
  }
  app.post("/api/jobs/:id/resume", async (req, reply) => {
    try { return repo.transitionJob(toInt((req.params as any).id, 0), "resume"); } catch (e) { return fail(reply, e); }
  });
  app.post("/api/jobs/:id/run", async (req, reply) => {
    try { const n = await deps.runner.drain(1); return { processed: n, jobs: repo.listJobs(undefined, 10) }; }
    catch (e) { return fail(reply, e); }
  });


  // ---------- v0.6.0 深度索引流水线（诊断 / 控制）----------
  const pipelineStats = () => {
    const pl = deps.pipeline ?? null;
    const limits = deps.limits ?? resolveLimits(null);
    const base = pl ? pl.stats() : (() => {
      const rows = repo.countIndexTasks();
      const sum = (state: string) => rows.filter((r: any) => r.state === state).reduce((n: number, r: any) => n + Number(r.count), 0);
      const stages = (["hash", "archive", "unitypackage", "thumbs", "meta", "categorize", "fts"] as const).map((stage) => {
        const s = rows.filter((r: any) => r.stage === stage);
        const at = (state: string) => s.filter((r: any) => r.state === state).reduce((n: number, r: any) => n + Number(r.count), 0);
        return { stage, queued: at("queued"), running: at("running"), waitingRetry: at("waiting_retry"), failed: at("failed"), done: at("done"), skipped: at("skipped"), avgMs: null as number | null };
      });
      return {
        started: false, paused: false, startedAt: "", running: sum("running"), queued: sum("queued"),
        waitingRetry: sum("waiting_retry"), failed: sum("failed"), done: sum("done"),
        cancelled: sum("cancelled"), skipped: sum("skipped"), stages,
        cache: deps.cache ? deps.cache.stats(limits.cacheMaxBytes) : { entries: 0, bytes: 0, hits: 0, hitRate: 0, maxBytes: limits.cacheMaxBytes, oldest: null },
        memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, heapTotal: process.memoryUsage().heapTotal, external: process.memoryUsage().external },
        processed: 0, failures: 0, lastError: null,
      };
    })();
    return { ...base, limits, nonDefaultLimits: nonDefaultLimits(limits) };
  };

  app.get("/api/pipeline", async () => pipelineStats());

  app.get("/api/pipeline/tasks", async (req, reply) => {
    try {
      const q = req.query as any;
      const tasks = repo.listIndexTasks({ state: q.state, stage: q.stage, assetId: q.assetId ? toInt(q.assetId, 0) : undefined, limit: toInt(q.limit, 100) });
      const withAsset = tasks.map((t: any) => {
        const a = t.asset_id ? repo.getAsset(Number(t.asset_id)) : null;
        return { ...t, path: a?.path ?? null, size: a?.size ?? null };
      });
      return { tasks: withAsset };
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/pipeline/events", async (req) => {
    const q = req.query as any;
    return { events: repo.listPipelineEvents(toInt(q.limit, 100), toInt(q.after, 0)) };
  });
  app.get("/api/pipeline/tasks/:id", async (req, reply) => {
    try {
      const t = repo.getIndexTask(toInt((req.params as any).id, 0));
      if (!t) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "任务不存在" } });
      const a = t.asset_id ? repo.getAsset(Number(t.asset_id)) : null;
      return { task: { ...t, path: a?.path ?? null, size: a?.size ?? null }, asset: a };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pipeline/tasks/:id/retry", async (req, reply) => {
    try { return { task: repo.requeueIndexTask(toInt((req.params as any).id, 0)) }; }
    catch (e) { return fail(reply, e); }
  });
  app.post("/api/pipeline/tasks/:id/cancel", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const t = repo.getIndexTask(id);
      if (!t) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "任务不存在" } });
      if (t.state === "running" && deps.pipeline) deps.pipeline.cancelAsset(Number(t.asset_id));
      return { task: repo.cancelIndexTask(id) };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pipeline/assets/:id/reindex", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      const priority = toInt((req.body as any)?.priority, 100);
      if (deps.pipeline) {
        const tasks = deps.pipeline.enqueueAsset(id, { priority });
        deps.pipeline.boost(id, priority);
        return { queued: tasks.length, assetId: id, tasks };
      }
      const r = await indexAsset(repo, deps.media, id, { hashMaxBytes: 8 * 1024 * 1024 * 1024 });
      return { queued: 0, assetId: id, result: r };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pipeline/assets/:id/boost", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const n = deps.pipeline ? deps.pipeline.boost(id, toInt((req.body as any)?.priority, 100)) : 0;
      return { boosted: n };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pipeline/pause", async () => { deps.pipeline?.pause(); return { paused: true, enabled: !!deps.pipeline }; });
  app.post("/api/pipeline/resume", async () => { deps.pipeline?.resume(); return { paused: false, enabled: !!deps.pipeline }; });
  app.post("/api/pipeline/gc", async (req, reply) => {
    try {
      if (!deps.cache) return reply.status(409).send({ error: { code: "CONFLICT", message: "缓存未启用" } });
      const l = deps.limits ?? resolveLimits(null);
      return deps.cache.gc({ maxBytes: l.cacheMaxBytes, maxAgeDays: l.cacheMaxAgeDays, keepEntries: l.cacheKeepEntries });
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/pipeline/limits", async () => {
    const l = deps.limits ?? resolveLimits(null);
    return { limits: l, nonDefault: nonDefaultLimits(l) };
  });
  app.put("/api/pipeline/limits", async (req, reply) => {
    try {
      const body = req.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "需要对象" } });
      const resolved = resolveLimits(body);
      repo.setSetting("pipeline_limits", JSON.stringify(resolved));
      return { saved: true, restartRequired: true, limits: resolved, nonDefault: nonDefaultLimits(resolved) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- roots / tags / projects ----------
  app.get("/api/roots", async () => ({ roots: repo.listRoots(), stats: repo.stats() }));
  app.post("/api/roots", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      if (!b?.path) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "path 必填" } });
      if (!existsSync(String(b.path))) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "路径不存在" } });
      return repo.ensureRoot(String(b.path), b.mode ?? "index_in_place");
    } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/roots/:id", async (req, reply) => {
    try { repo.removeRoot(toInt((req.params as any).id, 0)); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  // ---------- 标签（v3 §4：CRUD；身份 = (namespace, name)，颜色不是身份）----------
  /** 全部标签（含 color/sort/itemCount）；按 namespace → sort → name 排序（默认标签有显式 sort）。 */
  app.get("/api/tags", async () => ({
    tags: (repo.listTags() as any[]).slice().sort((a, b) =>
      String(a.namespace ?? "").localeCompare(String(b.namespace ?? ""))
      || (Number(a.sort ?? 0) - Number(b.sort ?? 0))
      || String(a.name).localeCompare(String(b.name))),
  }));
  /**
   * 建标签，**幂等**：同名（同 namespace）直接返回已存在的那条，绝不重复创建（契约 §4）。
   * 已存在 → 200；新建 → 201。响应体固定 `{ tag }`（另带 id 兼容旧调用方）。
   */
  app.post("/api/tags", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const name = String(b?.name ?? "").trim();
      if (!name) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "name 必填" } });
      const namespace = b?.namespace === undefined || b?.namespace === null ? null : String(b.namespace);
      const existed = (repo.listTags() as any[]).find((t: any) => String(t.name) === name && (t.namespace ?? null) === namespace);
      if (existed) return reply.status(200).send({ tag: existed, id: existed.id });
      const id = repo.ensureTag(name, namespace, b?.color === undefined || b?.color === null ? null : String(b.color));
      return reply.status(201).send({ tag: tagById(repo, id), id });
    } catch (e) { return fail(reply, e); }
  });
  /** 改名/改色：按 id 关联，素材上的标签自动跟随；改成已存在的名字 → 409。 */
  app.patch("/api/tags/:id", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const patch: { name?: string; color?: string | null; sort?: number } = {};
      if (b?.name !== undefined) patch.name = String(b.name);
      if (b?.color !== undefined) patch.color = b.color === null ? null : String(b.color);
      if (b?.sort !== undefined) patch.sort = toInt(b.sort, 0);
      return { tag: repo.updateTag(toInt((req.params as any).id, 0), patch) };
    } catch (e) { return fail(reply, e); }
  });
  /** 删标签：同时清掉 item_tags 关联（不删素材、不删文件）。 */
  app.delete("/api/tags/:id", async (req, reply) => {
    try { return repo.deleteTag(toInt((req.params as any).id, 0)); } catch (e) { return fail(reply, e); }
  });
  app.get("/api/projects", async () => ({ projects: repo.listProjects() }));
  app.post("/api/projects", async (req, reply) => {
    try { const b = (req.body ?? {}) as any; return { id: repo.ensureProject(String(b.name ?? basename(String(b.path))), String(b.path)) }; }
    catch (e) { return fail(reply, e); }
  });
  app.post("/api/projects/:id/imports", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      repo.addProjectImport(toInt((req.params as any).id, 0), toInt(b.itemId, 0), b.assetId ? toInt(b.assetId, 0) : null, b.note ?? null);
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });
  // ---------- 工程"实际引用"（登记导入 ≠ 工程里真的有）----------
  /** 扫工程 Assets/ 的 GUID 与素材库 GUID 求交，整表替换 project_refs。可能要跑几十秒（预算默认 45s）。 */
  app.post("/api/projects/:id/scan-usage", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const budgetMs = b?.budgetMs !== undefined ? toInt(b.budgetMs, 0) : 0;
      return await scanProjectUsage(repo, toInt((req.params as any).id, 0), budgetMs > 0 ? { budgetMs } : {});
    } catch (e) { return fail(reply, e); }
  });
  /** 这个条目被哪些工程**真的用到**（没扫过 → projects 为空数组，不是错误）。 */
  app.get("/api/items/:id/usage", async (req, reply) => {
    try {
      const itemId = toInt((req.params as any).id, 0);
      if (!itemId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "id 非法" } });
      return { itemId, projects: itemUsage(repo, itemId) };
    } catch (e) { return fail(reply, e); }
  });
  /** 这个工程**真的用到**了哪些素材（按命中文件数降序）。 */
  app.get("/api/projects/:id/usage", async (req, reply) => {
    try {
      const projectId = toInt((req.params as any).id, 0);
      const p = (repo.listProjects() as any[]).find((x) => Number(x.id) === projectId);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "工程不存在" } });
      return { projectId, name: String(p.name ?? ""), items: projectUsage(repo, projectId) };
    } catch (e) { return fail(reply, e); }
  });

  /**
   * unitypackage 里的资产路径 → {已落地的包文件, guid}。
   * 预览"包里的某个文件"时要按 pathname 反查 guid，压缩包还得先解出内层包 —— 所以缓存一份。
   */
  const upkgIndex = new Map<number, Map<string, { pkgFile: string; guid: string }>>();
  const UPKG_INDEX_MAX = 32;

  async function upkgIndexFor(assetId: number, itemId: number): Promise<Map<string, { pkgFile: string; guid: string }>> {
    const cached = upkgIndex.get(assetId);
    if (cached) return cached;
    const map = new Map<string, { pkgFile: string; guid: string }>();
    const a = repo.getAsset(assetId);
    if (a) {
      if (a.container === "unitypackage") {
        let rows = repo.getUnityPackageAssets(assetId) as any[];
        if (!rows.length) {
          const listing = await listUnityPackage(a.path, { maxAssets: 20000 });
          repo.replaceUnityPackageAssets(assetId, listing.assets);
          rows = repo.getUnityPackageAssets(assetId) as any[];
        }
        for (const r of rows) map.set(String(r.assetPath), { pkgFile: a.path, guid: String(r.guid) });
      } else if (a.container === "zip" || a.container === "7z" || a.container === "rar") {
        const stagingDir = join(deps.dataDir, "unity-staging");
        const cands = (await listUnityPackageCandidates(repo, itemId)).packages.filter((c) => c.assetId === assetId).slice(0, 6);
        for (const c of cands) {
          try {
            const staged = await stageUnityPackage(c, stagingDir);
            const listing = await listUnityPackage(staged.path, { maxAssets: 20000 });
            for (const x of listing.assets) map.set(String(x.assetPath), { pkgFile: staged.path, guid: String(x.guid) });
          } catch { /* 单个包失败不影响其他的 */ }
        }
      }
    }
    // 空结果不缓存：偶发读失败（网络盘/杀软占用）不该让这个资产"永远解析不出文件"
    if (map.size > 0) {
      upkgIndex.set(assetId, map);
      if (upkgIndex.size > UPKG_INDEX_MAX) { const oldest = upkgIndex.keys().next().value; if (oldest !== undefined) upkgIndex.delete(oldest); }
    }
    return map;
  }

  // ---------- Unity 编辑器（mcp-for-unity）：把素材真正导入"当前打开的那个工程" ----------
  app.get("/api/unity/status", async () => {
    // 状态探测用短超时的独立客户端：Unity 没开时不能把请求吊住。
    const u = new UnityMcp(unityUrls(), 8000);
    const candidates = unityUrls();
    try {
      const editor = await unityEditorInfo(u);
      const proj = (repo.listProjects() as any[]).find((p) => p.path_norm === normalizePath(editor.projectPath));
      return { ok: true, endpoint: u.endpoint, serverName: u.serverName, editor, projectAvatar: projectAvatarOf(editor.projectPath), projectId: proj?.id ?? null, registered: !!proj, candidates };
    } catch (e) {
      return { ok: false, endpoint: u.endpoint, serverName: "", error: String((e as Error)?.message ?? e), projectAvatar: null, candidates };
    }
  });

  /**
   * 列出这个条目里所有可导入的 .unitypackage（压缩包内的、zip 套 zip 的都列）。
   * ?project=<工程路径> → 顺便把"这个包是给哪个 avatar 的 / 是不是当前工程那个"标出来。
   */
  app.get("/api/unity/packages", async (req, reply) => {
    try {
      const q = req.query as any;
      const itemId = toInt(q.itemId, 0);
      if (!itemId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "itemId 必填" } });
      const projectAvatar = projectAvatarOf(q.project ? String(q.project) : null);
      const scan = await listUnityPackageCandidates(repo, itemId, {
        avatars: avatarLite(), projectAvatarId: projectAvatar?.id ?? null,
        refresh: q.refresh === "1" || q.refresh === "true",
      });
      return {
        itemId, projectAvatar, scanErrors: scan.scanErrors,
        packages: scan.packages.map((p) => ({ ...p, avatar: p.avatar ?? null, matched: !!p.matched })),
      };
    } catch (e) { return fail(reply, e); }
  });

  /** 真正导入：解出包 → AssetDatabase.ImportPackage(path,false) → 登记 project_imports。 */
  app.post("/api/unity/import", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const itemId = toInt(b.itemId, 0);
      if (!itemId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "itemId 必填" } });
      if (!repo.getItem(itemId)) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });

      const u = unity();
      const editor = await unityEditorInfo(u);
      const projectAvatar = projectAvatarOf(editor.projectPath);
      const all = (await listUnityPackageCandidates(repo, itemId, { avatars: avatarLite(), projectAvatarId: projectAvatar?.id ?? null })).packages;
      const keys: string[] = Array.isArray(b.keys) ? b.keys.map((k: any) => String(k)) : [];
      // 没显式指定要哪些包时：优先只导"当前工程那个 avatar"的包（存在的话），否则全导
      const auto = projectAvatar ? all.filter((c) => c.matched) : [];
      const picked = (keys.length ? all.filter((c) => keys.includes(c.key)) : (auto.length ? auto : all)).slice(0, 20);
      if (!picked.length) {
        return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "这个条目里没有可导入的 .unitypackage（压缩包还没索引的话，先在资产上重建索引）" } });
      }

      // 先清控制台：导入后读到的 error 才是这次导入产生的（否则会把编辑器里的历史报错算成导入报错）。
      const consoleCleared = await clearUnityConsole(u);
      const stagingDir = join(deps.dataDir, "unity-staging");
      const staged: { key: string; label: string; assetId: number; stagedPath: string; bytes: number }[] = [];
      for (const c of picked) {
        const s = await stageUnityPackage(c, stagingDir);
        staged.push({ key: c.key, label: c.label, assetId: c.assetId, stagedPath: s.path, bytes: s.bytes });
      }

      const r = await importPackagesIntoUnity(u, staged.map((s) => s.stagedPath));
      const projectId = repo.ensureProject(editor.projectName || basename(editor.projectPath), editor.projectPath);
      repo.setProjectUnityVersion(projectId, editor.unityVersion || null);
      for (const s of staged) {
        repo.addProjectImport(projectId, itemId, s.assetId, "unity:" + s.label + " (" + Math.round(s.bytes / 1048576) + "MB)");
      }

      // Unity 的导入是异步的：等一拍再读控制台里的 error，方便前端直接显示"导完有没有报错"。
      let consoleErrors: string[] = [];
      if (r.queued.length) { await sleep(1800); consoleErrors = await readUnityConsole(u, ["error"], 20); }
      deps.log("unity import: item " + itemId + " -> " + editor.projectName + " queued=" + r.queued.length + " failed=" + r.failed.length + " errors=" + consoleErrors.length);

      return {
        ok: r.failed.length === 0, endpoint: u.endpoint,
        project: { id: projectId, name: editor.projectName, path: editor.projectPath, unityVersion: editor.unityVersion, avatar: projectAvatar },
        autoMatched: keys.length === 0 && auto.length > 0,
        imported: staged.map((s) => ({ key: s.key, label: s.label, stagedPath: s.stagedPath, bytes: s.bytes })),
        consoleCleared, queued: r.queued, failed: r.failed, consoleErrors, raw: r.raw,
      };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 套装 / 合集（collection）与条目合并 ----------
  app.get("/api/collections", async () => ({ collections: repo.listCollections() }));
  app.post("/api/collections", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const name = String(b?.name ?? "").trim();
      if (!name) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "name 必填" } });
      const id = repo.ensureCollection(name);
      if (Array.isArray(b.itemIds) && b.itemIds.length) repo.addToCollection(id, b.itemIds.map((n: any) => toInt(n, 0)).filter(Boolean));
      return { id, name, itemCount: repo.collectionItems(id).length };
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/collections/:id", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const ids = repo.collectionItems(id);
      const items = ids.map((i) => repo.getItem(i)).filter(Boolean);
      return { id, itemIds: ids, items };
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/collections/:id/items", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const itemIds = ((req.body as any)?.itemIds ?? []).map((n: any) => toInt(n, 0)).filter(Boolean);
      const added = repo.addToCollection(id, itemIds);
      return { added, itemCount: repo.collectionItems(id).length };
    } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/collections/:id/items/:itemId", async (req, reply) => {
    try { repo.removeFromCollection(toInt((req.params as any).id, 0), toInt((req.params as any).itemId, 0)); return { ok: true }; }
    catch (e) { return fail(reply, e); }
  });
  app.delete("/api/collections/:id", async (req, reply) => {
    try { repo.deleteCollection(toInt((req.params as any).id, 0)); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  /** 合并两条素材（例如同一商品的"模型包 + 材质包"）：资产/图片/模型/标签/更新历史全部归到目标条目，来源进回收站可恢复。 */
  app.post("/api/items/merge", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const sourceId = toInt(b.sourceId, 0), targetId = toInt(b.targetId, 0);
      if (!sourceId || !targetId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "sourceId/targetId 必填" } });
      const r = repo.mergeItems(sourceId, targetId);
      await matchItem(repo, targetId, {});
      deps.log("merge: item " + sourceId + " -> " + targetId + " assets=" + r.movedAssets + " images=" + r.movedImages);
      return { ...r, target: repo.getItem(targetId) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 物品分类（v3；契约 docs/categories-v3.md §4/§5/§6）----------
  /** 分类树（含 itemCount）+ 统计 + 阈值配置。 */
  app.get("/api/categories", async (req, reply) => {
    try {
      return { categories: repo.listCategories(), stats: repo.categoryStats(), config: getCategoryConfig(repo) };
    } catch (e) { return fail(reply, e); }
  });

  // ⚠️ 路由顺序：静态段 /api/categories/counts 必须注册在 /api/categories/:id* 之前，
  // 否则 "counts" 会被当成 :id（分类管理端点下面的 PATCH/DELETE/impact 同理，全部注册在建分类之前/之后都行，
  // 但静态段一律先来 —— 这是本文件的约定）。
  /**
   * 当前筛选下的分类计数（契约 §5）：**与 /api/items 完全相同的筛选参数**，一次 GROUP BY 算出（不是每个分类查一次）。
   * 返回 { all, uncategorized, tops: {id:count}, subs: {id:count} }；分类筛选参数本身不参与计数（repo 层已剔除）。
   * 恒等式：counts.all === GET /api/items（同一 query）.total。
   */
  app.get("/api/categories/counts", async (req, reply) => {
    try { return repo.categoryCounts(parseItemQuery(req.query as any)); } catch (e) { return fail(reply, e); }
  });

  app.post("/api/categories", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const name = String(b?.name ?? "").trim();
      if (!name) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "name 必填" } });
      const category = repo.createCategory({
        id: b?.id === undefined || b.id === null ? undefined : String(b.id).trim(),
        name, parentId: b?.parentId === undefined || b.parentId === null ? null : String(b.parentId),
        sort: b?.sort === undefined ? undefined : toInt(b.sort, 0),
      });
      return reply.status(201).send({ category });
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/api/categories/:id", async (req, reply) => {
    try {
      const id = String((req.params as any).id ?? "");
      const b = (req.body ?? {}) as any;
      const patch: { name?: string; parentId?: string | null; sort?: number; enabled?: boolean } = {};
      if (b?.name !== undefined) patch.name = String(b.name);
      if (b?.parentId !== undefined) patch.parentId = b.parentId === null ? null : String(b.parentId);
      if (b?.sort !== undefined) patch.sort = toInt(b.sort, 0);
      if (b?.enabled !== undefined) patch.enabled = isTrue(b.enabled);
      // v3 §2-3：系统分类（builtin）不可删除、**不可停用**（repo 层只管删除，这里补上停用这一半）。
      if (patch.enabled === false) {
        const cur = repo.categoryDefs().find((d) => d.id === id);
        if (!cur) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "分类不存在: " + id } });
        if (cur.builtin) return reply.status(409).send({ error: { code: "CONFLICT", message: "系统分类不能停用: " + id } });
      }
      return { category: repo.updateCategory(id, patch) };
    } catch (e) { return fail(reply, e); }
  });

  /** 删除/合并前的影响面：{items, direct, subs, suggestions, children}（UI 二次确认要显示的数字）。 */
  app.get("/api/categories/:id/impact", async (req, reply) => {
    try { return repo.categoryImpact(String((req.params as any).id ?? "")); } catch (e) { return fail(reply, e); }
  });

  /** 子分类换父（ID 不变，契约 §6.2）→ { category }。 */
  app.post("/api/categories/:id/move", async (req, reply) => {
    try {
      const id = String((req.params as any).id ?? "");
      const b = (req.body ?? {}) as any;
      const parentId = b?.parentId === undefined || b?.parentId === null ? "" : String(b.parentId).trim();
      if (!parentId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "parentId 必填（目标一级分类）" } });
      return { category: repo.moveCategory(id, parentId) };
    } catch (e) { return fail(reply, e); }
  });

  /** 合并分类：素材与建议先迁到 intoId 再删源（事务，绝不删素材）→ { moved, deleted }。系统分类不能作为源（409）。 */
  app.post("/api/categories/:id/merge", async (req, reply) => {
    try {
      const id = String((req.params as any).id ?? "");
      const b = (req.body ?? {}) as any;
      const intoId = b?.intoId === undefined || b?.intoId === null ? "" : String(b.intoId).trim();
      if (!intoId) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "intoId 必填（合并目标）" } });
      const r = repo.mergeCategories(id, intoId);
      return { moved: r.moved, deleted: r.deleted, movedSuggestions: r.movedSuggestions };
    } catch (e) { return fail(reply, e); }
  });

  /**
   * 删除分类：素材先转移到 transferTo（分类 ID / none / 缺省 = 未分类）再删行，事务内完成，**绝不删素材**。
   * 系统分类 → 409（repo 层）；分类不存在 → 404。
   */
  app.delete("/api/categories/:id", async (req, reply) => {
    try {
      const id = String((req.params as any).id ?? "");
      const raw = (req.query as any)?.transferTo;
      const transferTo = raw === undefined || raw === null || String(raw).trim() === "" || String(raw).trim().toLowerCase() === "none"
        ? null : String(raw).trim();
      const r = repo.deleteCategory(id, { transferTo });
      return { moved: r.moved, movedSubs: r.movedSubs, deleted: r.deleted, movedSuggestions: r.movedSuggestions };
    } catch (e) { return fail(reply, e); }
  });

  app.put("/api/categories/config", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      return setCategoryConfig(repo, { autoThreshold: b?.autoThreshold, suggestThreshold: b?.suggestThreshold });
    } catch (e) { return fail(reply, e); }
  });

  /**
   * 批量重跑分类。默认 **不改归属**（apply=false 只写建议）；apply=true 也只经 applyAutoCategory，
   * manual/confirmed 记 protected 且不被覆盖。范围：itemIds > onlyUncategorized > all（三者都缺 → 400）。
   */
  app.post("/api/categories/reclassify", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const itemIds = Array.isArray(b?.itemIds) ? b.itemIds.map((n: any) => toInt(n, 0)).filter((n: number) => n > 0) : undefined;
      const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
      return reclassifyCategories(repo, {
        itemIds,
        onlyUncategorized: truthy(b?.onlyUncategorized),
        apply: truthy(b?.apply),
        all: truthy(b?.all),
        limit: b?.limit === undefined ? undefined : toInt(b.limit, 0),
        log: deps.log,
      });
    } catch (e) { return fail(reply, e); }
  });

  // 注意：静态段必须先于 /api/items/:id/... 注册（/api/items/category/batch 否则会被当成 id）。
  /** 批量分类：set（设为某分类/清空）/ clear_sub（只移除子分类）/ resuggest（重算建议）。 */
  app.post("/api/items/category/batch", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const mode = b?.mode === undefined || b.mode === null ? "set" : String(b.mode);
      if (mode !== "set" && mode !== "clear_sub" && mode !== "resuggest") {
        return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "mode 必须是 set/clear_sub/resuggest" } });
      }
      // 显式标 number[]：b 是 any，Set 从 any 推断会得到 Set<unknown>（随后 itemId 变 unknown）
      const requested: number[] = Array.isArray(b?.itemIds) ? (b.itemIds as unknown[]).map((n) => toInt(n, 0)).filter((n) => n > 0) : [];
      const ids: number[] = [...new Set(requested)];
      if (ids.length === 0) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "itemIds 必填（非空数组）" } });
      const categoryId = b?.categoryId === undefined || b?.categoryId === null ? null : String(b.categoryId);
      const subCategoryId = b?.subCategoryId === undefined || b?.subCategoryId === null ? null : String(b.subCategoryId);
      let updated = 0;
      const failed: { itemId: number; reason: string }[] = [];
      for (const itemId of ids) {
        const row = repo.itemRow(itemId);
        if (!row) { failed.push({ itemId, reason: "条目不存在" }); continue; }
        try {
          if (mode === "set") {
            repo.setItemCategory(itemId, { categoryId, subCategoryId, source: "manual" });
          } else if (mode === "clear_sub") {
            if (!row.cat_id) { failed.push({ itemId, reason: "条目未分类，没有子分类可移除" }); continue; }
            repo.setItemCategory(itemId, {
              categoryId: row.cat_id, subCategoryId: null, source: row.cat_source ?? "manual",
              confidence: row.cat_confidence, reason: row.cat_reason, evidence: row.cat_evidence,
            });
          } else {
            const rec = recommendForItem(repo, itemId);
            if (!rec.categoryId) repo.clearItemCategorySuggestion(itemId);
            else repo.suggestItemCategory(itemId, {
              categoryId: rec.categoryId, subCategoryId: rec.subCategoryId, confidence: rec.confidence,
              reason: rec.reason, evidence: evidenceToJson(rec),
            });
          }
          updated++;
        } catch (e) { failed.push({ itemId, reason: String((e as any)?.message ?? e) }); }
      }
      return { updated, failed, requested: requested.length };
    } catch (e) { return fail(reply, e); }
  });

  /** 手动设置分类（source='manual'）；categoryId=null 清除归属。子分类不属于主分类 → repo 自动清空子分类。 */
  app.post("/api/items/:id/category", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      if (!repo.itemRow(id)) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      const b = (req.body ?? {}) as any;
      const categoryId = b?.categoryId === undefined || b?.categoryId === null ? null : String(b.categoryId);
      const subCategoryId = b?.subCategoryId === undefined || b?.subCategoryId === null ? null : String(b.subCategoryId);
      repo.setItemCategory(id, { categoryId, subCategoryId, source: "manual" });
      return { item: repo.getItem(id) };
    } catch (e) { return fail(reply, e); }
  });

  /** 采纳当前建议：source='confirmed'，同时清掉建议。没有建议 → 400。 */
  app.post("/api/items/:id/category/accept", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const row = repo.itemRow(id);
      if (!row) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      if (!row.cat_suggest_id) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "该条目没有待确认的分类建议" } });
      repo.setItemCategory(id, {
        categoryId: row.cat_suggest_id, subCategoryId: row.cat_suggest_sub_id, source: "confirmed",
        confidence: row.cat_suggest_confidence, reason: row.cat_suggest_reason, evidence: row.cat_suggest_evidence,
      });
      return { item: repo.getItem(id) };
    } catch (e) { return fail(reply, e); }
  });

  /** 忽略建议：只清建议，不动归属。 */
  app.post("/api/items/:id/category/dismiss", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      if (!repo.itemRow(id)) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      repo.clearItemCategorySuggestion(id);
      return { item: repo.getItem(id) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 疑似同商品（模型包 / 材质包 / DLC 分别打包）----------
  /**
   * 归档里的一级条目名（目录名/文件名）：zip/7z/rar 取最外层条目（path 不含分隔符）、
   * unitypackage 取 asset_path 的一级段。只读缓存表，不重扫包。
   */
  const relatedEntryNames = (itemId: number): string[] => {
    const out = new Set<string>();
    for (const a of repo.listAssets(itemId)) {
      if (a.container === "unitypackage") {
        for (const u of repo.getUnityPackageAssets(a.id) as any[]) {
          const seg = String(u?.assetPath ?? "").split(/[\\/]/).filter(Boolean)[0];
          if (seg) out.add(seg);
        }
      } else if (a.container === "zip" || a.container === "7z" || a.container === "rar") {
        for (const en of repo.getArchiveEntries(a.id) as any[]) {
          const p = String(en?.path ?? "");
          if (!p || p.includes("/") || p.includes("\\")) continue;   // 只看最外层
          out.add(p);
        }
      }
    }
    return [...out];
  };

  /**
   * 某条目的「疑似同商品」：比标题/标签/包内一级条目名，不比字节（那是去重的活）。
   * 候选 = 所有非 trashed 条目（分页取全，listItems 单页上限 500），排除自己；
   * 同商品但已在同一 collection 里的也照常返回（UI 自己决定显示什么）。
   */
  app.get("/api/items/:id/related", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const self = repo.getItem(id);
      if (!self) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      const q = req.query as any;
      const rawMin = Number(q.min);
      const min = Number.isFinite(rawMin) ? Math.min(1, Math.max(0, rawMin)) : 0.6;
      const limit = Math.min(100, Math.max(1, toInt(q.limit, 10)));
      // 先把候选取全：既要算"标签文档频率"，也要在排序后再截断
      const cards: any[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = repo.listItems({ limit: 500, offset, includeTrashed: false });
        for (const card of page.items) if (card.id !== id) cards.push(card);
        if (page.items.length === 0 || offset + 500 >= page.total) break;
      }
      // 通用标签不构成"同商品"证据：VRChat / マヌカ / セレスティア 这类被三成以上条目打过的标签直接不喂给匹配器
      // （否则 #6 那种 33 标签的条目，反向查同商品时前 10 条全是标签误报，真正同商品的材质包被挤出 limit）。
      const df = new Map<string, number>();
      for (const c of cards) for (const t of new Set<string>((c.tags ?? []).map((x: any) => String(x)))) df.set(t, (df.get(t) ?? 0) + 1);
      const commonCut = Math.max(3, Math.ceil(cards.length * 0.3));
      const rareTags = (tags: unknown): string[] => (Array.isArray(tags) ? tags.map((t) => String(t)) : []).filter((t) => (df.get(t) ?? 0) < commonCut);

      // 哪些 key 根本不能当"商品名"证据：
      //  ① 头像名/别名（MANUKA / SELESTIA / MILFY…）——那是"适配谁"，不是"哪个商品"；
      //     实测不排掉的话，#6（包内全是 *_V2.zip）会和一堆含 Manuka 内容的条目 100% 判成同商品。
      //  ② 全库高频 key（≥30% 条目都出现的词）——VRChat / テクスチャ 这类通用词。
      const avatarKeys = new Set<string>();
      for (const a of repo.listAvatars() as any[]) {
        avatarKeys.add(normKey(String(a.name ?? "")));
        for (const al of a.aliases ?? []) avatarKeys.add(normKey(String(al)));
      }
      const entriesById = new Map<number, string[]>();
      for (const card of cards) entriesById.set(card.id, relatedEntryNames(card.id));
      const selfEntries = relatedEntryNames(id);

      const keyDf = new Map<string, number>();
      const bump = (texts: string[]): void => {
        for (const k of new Set(texts.flatMap((t) => productKeysOf(t)).map((k) => normKey(k)))) keyDf.set(k, (keyDf.get(k) ?? 0) + 1);
      };
      for (const card of cards) bump([...rareTags(card.tags), ...(entriesById.get(card.id) ?? [])]);
      bump([...rareTags(self.tags), ...selfEntries]);
      const keyCut = Math.max(3, Math.ceil((cards.length + 1) * 0.3));
      const ignoreKeys = new Set<string>(avatarKeys);
      for (const [k, n] of keyDf) if (n >= keyCut) ignoreKeys.add(k);

      const selfInput = { itemId: id, title: self.title, tags: rareTags(self.tags), entryNames: selfEntries };

      const matches: { itemId: number; title: string; score: number; level: string; shared: string[]; reason: string; assetCount: number; imageCount: number }[] = [];
      for (const card of cards) {
        const m = relateItems(selfInput, { itemId: card.id, title: card.title, tags: rareTags(card.tags), entryNames: entriesById.get(card.id) ?? [] }, min, { ignoreKeys });
        if (!m) continue;
        matches.push({ itemId: card.id, title: card.title, score: m.score, level: m.level, shared: m.shared, reason: m.reason, assetCount: card.assetCount, imageCount: card.imageCount });
      }
      matches.sort((a, b) => b.score - a.score || a.itemId - b.itemId);
      return { itemId: id, min, matches: matches.slice(0, limit) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 去重（智能查重）----------
  /** 某条目的重复资产：matches 额外带 otherTitle/otherPath/otherVersionKey，前端可直接显示。 */
  app.get("/api/items/:id/duplicates", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const q = req.query as any;
      const rawMin = Number(q.min);
      const min = Number.isFinite(rawMin) ? Math.min(1, Math.max(0, rawMin)) : 0.9;
      const limit = Math.min(200, Math.max(1, toInt(q.limit, 20)));
      const rescan = q.rescan === "1" || q.rescan === "true";
      const matches = await findDuplicatesForItem(repo, id, { minSimilarity: min, limit, rescan });
      return { itemId: id, min, matches };
    } catch (e) { return fail(reply, e); }
  });

  /** 全库跨条目重复组（并查集合并；只报相似度 >= min 的组）。 */
  app.get("/api/duplicates", async (req, reply) => {
    try {
      const q = req.query as any;
      const rawMin = Number(q.min);
      const min = Number.isFinite(rawMin) ? Math.min(1, Math.max(0, rawMin)) : 0.9;
      const limit = Math.min(1000, Math.max(1, toInt(q.limit, 100)));
      const recompute = q.recompute === "1" || q.recompute === "true";
      const groups = await listDuplicateGroups(repo, { minSimilarity: min, limit, recompute });
      return { min, groups };
    } catch (e) { return fail(reply, e); }
  });

  /** 重算签名（只补缺失/stale 的；有 45s 预算，保证接口秒级返回）。 */
  app.post("/api/duplicates/recompute", async (req, reply) => {
    try {
      const r = await recomputeSignatures(repo, { budgetMs: 45000 });
      deps.log("duplicates recompute: scanned=" + r.scanned + " updated=" + r.updated + " remaining=" + r.remaining + " ms=" + r.ms);
      return { scanned: r.scanned, updated: r.updated };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- settings ----------
  app.get("/api/settings", async () => ({
    downloadRoot: downloadRootOf(repo, deps.dataDir),
    dataDir: deps.dataDir,
    dbPath: deps.dbPath,
    watchPaths: listWatches(repo),
    unityMcpUrl: (repo.getSetting("unity_mcp_url") ?? "").trim(),
    unityMcpCandidates: UNITY_MCP_URLS,
    /** 检查更新的仓库覆盖（owner/repo）；空 = 用内置默认仓库 */
    updateRepo: (repo.getSetting(UPDATE_REPO_KEY) ?? "").trim(),
    /** token 只回"有没有配"，不回值本身 */
    updateTokenSet: !!(repo.getSetting(UPDATE_TOKEN_KEY) ?? "").trim(),
  }));
  app.put("/api/settings", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      if (typeof b.downloadRoot === "string" && b.downloadRoot.trim()) {
        mkdirSync(b.downloadRoot.trim(), { recursive: true });
        repo.setSetting("download_root", b.downloadRoot.trim());
      }
      if (typeof b.unityMcpUrl === "string") repo.setSetting("unity_mcp_url", b.unityMcpUrl.trim());
      // 检查更新的仓库覆盖：空串 = 清掉（回到内置默认）；形状非法直接 400，别让脏值悄悄留库
      if (typeof b.updateRepo === "string") {
        const v = b.updateRepo.trim();
        if (v && !REPO_SLUG_RE.test(v)) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "updateRepo 形状应为 owner/repo" } });
        repo.setSetting(UPDATE_REPO_KEY, v);
      }
      // GitHub token（可选，提高匿名 60 次/小时的额度）：空串 = 清掉。**只进不出**，回包里只给"有没有"。
      if (typeof b.updateToken === "string") repo.setSetting(UPDATE_TOKEN_KEY, b.updateToken.trim());
      return {
        downloadRoot: downloadRootOf(repo, deps.dataDir),
        unityMcpUrl: (repo.getSetting("unity_mcp_url") ?? "").trim(),
        updateRepo: (repo.getSetting(UPDATE_REPO_KEY) ?? "").trim(),
        updateTokenSet: !!(repo.getSetting(UPDATE_TOKEN_KEY) ?? "").trim(),
      };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- 检查更新 ----------
  /**
   * 契约（冻结）：永远 200。
   * 成功 → {ok:true, current, latest, hasUpdate, publishedAt, url, notes, assetName, assetSize, checkedAt, fromCache}
   * 失败 → {ok:false, error, current, checkedAt}（联网失败/限流/tag 解析不了都走这里，**绝不 500**）
   * ?force=1 绕过 6h 缓存；仓库地址（settings.update_repo）变化时缓存自动失效。
   */
  app.get("/api/update-check", async (req) => {
    const q = (req.query ?? {}) as any;
    const force = q.force === "1" || q.force === "true" || q.force === 1 || q.force === true;
    return runUpdateCheck(repo, deps.version, force);
  });

  // ---------- BOOTH 下载（协议接管 / 手动粘贴下载链接）----------
  app.post("/api/import/download", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const protocol = b.protocolUrl ? parseProtocolUrl(String(b.protocolUrl)) : null;
      const dlUrl: string = protocol?.dlUrl ?? String(b.url ?? "");
      const itemId: string | null = protocol?.itemId ?? (b.itemId ? String(b.itemId) : null);
      const fileName: string | null = b.fileName ?? protocol?.fileName ?? null;
      if (!dlUrl) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "缺少 url/protocolUrl，或其 dlurl 不是合法的 https 下载地址" } });
      if (!isAllowedBoothUrl(dlUrl)) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "只接受 BOOTH 的 https 下载地址" } });
      const root = String(b.downloadRoot ?? downloadRootOf(repo, deps.dataDir));
      const destDir = join(root, itemId ? "b" + itemId : "b-unknown");
      const dl = await downloadBoothFile({ dlUrl, destDir, fileName, log: deps.log });

      let targetItem: number | null = null;
      let images = 0;
      if (itemId) {
        // 有商品号：顺手把商品元数据 + 图集也抓了（幂等）
        try {
          const meta = await importBoothUrl(repo, deps.media, booth, "https://booth.pm/ja/items/" + itemId);
          targetItem = meta.itemId; images = meta.images;
        } catch (e) { deps.log("download: 元数据抓取失败（文件已保存）: " + String((e as Error).message)); }
      }
      if (targetItem === null) {
        const row = repo.createItem({ title: dl.fileName.replace(/\.[^.]+$/, ""), source_site: "local", status: "inbox" });
        targetItem = row.id;
      }
      const st2 = statSync(dl.path);
      const container = (dl.fileName.match(/\.([^.]+)$/)?.[1] ?? "file").toLowerCase() as any;
      const rootRow = repo.listRoots()[0] ?? repo.ensureRoot(destDir, "index_in_place");
      const up = repo.upsertAsset({
        item_id: targetItem, kind: container === "unitypackage" ? "unitypackage" : "archive", container,
        path: dl.path, path_norm: normalizePath(dl.path), root_id: (rootRow as any).id, size: st2.size,
        mtime: st2.mtime.toISOString(), discovered_by: "download",
      });
      const job = repo.createJob("reindex", targetItem, { assetId: up.asset.id }, 5);
      deps.log("download ok: " + dl.path + " (" + dl.bytes + "B) -> item " + targetItem + " job " + job.id);
      return { itemId: targetItem, path: dl.path, bytes: dl.bytes, fileName: dl.fileName, images, assetId: up.asset.id, jobId: job.id };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- inbox watch ----------
  app.get("/api/watch", async () => ({ watches: listWatches(repo) }));
  app.post("/api/watch", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const p = String(b?.path ?? "");
      if (!p) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "path 必填" } });
      if (!existsSync(p)) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "路径不存在" } });
      const entries = listWatches(repo).filter((e) => e.path !== p);
      entries.push({ path: p, enabled: b.enabled === false ? false : true });
      setWatches(repo, entries);
      deps.watcher?.sync();
      return { watches: listWatches(repo) };
    } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/watch", async (req, reply) => {
    try {
      const p = String((req.query as any).path ?? "");
      setWatches(repo, listWatches(repo).filter((e) => e.path !== p));
      deps.watcher?.sync();
      return { watches: listWatches(repo) };
    } catch (e) { return fail(reply, e); }
  });

  // ---------- maintenance ----------
  app.post("/api/admin/rematch", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const limit = Math.max(1, toInt(b?.limit, 100000));
      // repo.listItems 把单页 limit 夹在 500：以前这里传 100000，实际只会重匹配前 500 条却说 total=500。
      // 先按 500 一页把 id 收全（收 id 期间不写库，排序稳定），再按 limit 逐条重匹配。
      const page = 500;
      const ids: number[] = [];
      for (let offset = 0; ids.length < limit; offset += page) {
        const res = repo.listItems({ limit: page, offset, includeTrashed: false });
        for (const card of res.items) { if (ids.length >= limit) break; ids.push(card.id); }
        if (res.items.length === 0 || offset + page >= res.total) break;
      }
      let done = 0, errors = 0;
      for (const id of ids) {
        try { await matchItem(repo, id, {}); done++; }
        catch { errors++; }
      }
      return { requeued: done, errors, total: ids.length };
    } catch (e) { return fail(reply, e); }
  });

  /** 给"有图但没设封面"的条目补封面（历史数据修复；幂等）。 */
  app.post("/api/admin/fix-covers", async () => {
    const r = repo.fixMissingCovers();
    deps.log("fix-covers: " + r.fixed + " items");
    return r;
  });

  // ---------- 工作台：结构单元 / 关系 / 导入计划（v8） ----------
  /** POST /api/workbench/scan：异步分析一个条目的容器/资源单元（重复请求由 jobs 的 item+kind 唯一索引兜底）。 */
  app.post("/api/workbench/scan", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const itemId = toInt(b.itemId, 0);
      if (!itemId || !repo.getItem(itemId)) {
        return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "itemId 无效或条目不存在" } });
      }
      let job: any;
      try {
        job = repo.createJob("structure", itemId, { itemId, refresh: b.refresh === true }, 20);
      } catch (e) {
        if (String((e as any)?.code ?? "").includes("SQLITE_CONSTRAINT")) {
          return reply.status(409).send({ error: { code: "CONFLICT", message: "该条目已有结构分析作业在跑" } });
        }
        throw e;
      }
      return reply.status(202).send({ jobId: job.id, itemId, state: job.state });
    } catch (e) { return fail(reply, e); }
  });

  /** POST /api/workbench/scan-all：一键分析所有有归档资产的条目（item_id=NULL + payload.all）。 */
  app.post("/api/workbench/scan-all", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const onlyMissing = b.onlyMissing === true;
      const inflight = repo.findInflightStructureAllJob();
      if (inflight) {
        return reply.status(409).send({ error: { code: "CONFLICT", message: "已有批量结构分析作业在跑", jobId: inflight.id } });
      }
      const job = repo.createJob("structure", null, { all: true, onlyMissing }, 15);
      return reply.status(202).send({ jobId: job.id, onlyMissing });
    } catch (e) { return fail(reply, e); }
  });

  /** GET /api/workbench/avatars?itemId=：按头像聚合单元证据计数。 */
  app.get("/api/workbench/avatars", async (req) => {
    const q = req.query as any;
    const itemId = q.itemId ? toInt(q.itemId, 0) || undefined : undefined;
    return repo.workbenchAvatarCounts(itemId);
  });

  /** GET /api/workbench/units：单元视图（证据/policy/来源条目与资产）。 */
  app.get("/api/workbench/units", async (req) => {
    const q = req.query as any;
    const rows = repo.listUnits({
      itemId: q.itemId ? toInt(q.itemId, 0) || undefined : undefined,
      avatarId: q.avatarId ? toInt(q.avatarId, 0) || undefined : undefined,
      policy: q.policy ? String(q.policy) : undefined,
      level: q.level ? String(q.level) : undefined,
      itemStatus: q.itemStatus ? String(q.itemStatus) : undefined,
      limit: q.limit ? toInt(q.limit, 1000) : 1000,
    });
    const safe = (t: any) => { try { return JSON.parse(String(t ?? "null")); } catch { return null; } };
    return rows.map((u) => ({
      id: Number(u.id), assetId: Number(u.asset_id), itemId: u.item_id ?? null,
      relPath: String(u.rel_path), format: String(u.format), kind: String(u.kind), name: String(u.name),
      size: Number(u.size) || 0, fingerprint: u.fingerprint ?? null,
      policy: String(u.policy), importable: !!u.importable, mixed: u.policy === "mixed_unitypackage",
      parseState: String(u.parse_state), parseError: u.parse_error ?? null,
      avatars: safe(u.avatar_json) ?? [], evidence: safe(u.evidence_json),
      item: u.item_id ? { id: Number(u.item_id), title: u.item_title ?? "", status: u.item_status ?? null } : null,
      asset: { id: Number(u.asset_id), path: u.asset_path ?? "", kind: u.asset_kind ?? null, container: u.asset_container ?? null, size: Number(u.asset_size) || 0 },
      updatedAt: u.updated_at,
    }));
  });

  /** POST /api/import-plans：按单元建计划（mixed 仍引用原始整包；precheck 指纹/文件/策略）。 */
  app.post("/api/import-plans", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      const unitIds = Array.isArray(b.unitIds) ? b.unitIds.map((n: any) => toInt(n, 0)).filter((n: number) => n > 0) : [];
      const batch = createImportPlanBatch(repo, { unitIds, projectPath: String(b.projectPath ?? ""), includeSuggested: b.includeSuggested === true });
      // 单 item 保持原契约 {plan,items,precheck}；跨 item 返回 {plans:[...]}（失败组带 error，隔离）
      return reply.status(201).send(batch.single ? batch.view : { plans: batch.plans });
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/import-plans/:id", async (req, reply) => {
    try {
      const view = getPlanView(repo, toInt((req.params as any).id, 0));
      if (!view) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "计划不存在" } });
      return view;
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/import-plans/:id/confirm", async (req, reply) => {
    try { return confirmImportPlan(repo, toInt((req.params as any).id, 0)); }
    catch (e) { return fail(reply, e); }
  });

  /**
   * POST /api/import-plans/:id/execute：只做前置校验并创建 import job（202 {jobId,planId}）。
   * 实际 Unity 导入在 runner 内执行；外部副作用禁止自动重试（失败 → run interrupted / plan failed）。
   */
  app.post("/api/import-plans/:id/execute", async (req, reply) => {
    try {
      const planId = toInt((req.params as any).id, 0);
      const pre = precheckImportPlan(repo, planId);
      const inflight = repo.findInflightImportJob(planId);
      if (inflight) {
        return reply.status(409).send({ error: { code: "CONFLICT", message: "该计划已有执行作业在跑", jobId: inflight.id } });
      }
      const job = repo.createJob("import", Number(pre.plan.item_id), { planId }, 40);
      return reply.status(202).send({ jobId: job.id, planId });
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/import-runs/:id", async (req, reply) => {
    try {
      const view = getRunView(repo, toInt((req.params as any).id, 0));
      if (!view) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "执行记录不存在" } });
      return view;
    } catch (e) { return fail(reply, e); }
  });

  // ---------- media / stats / export ----------
  app.get("/api/media/:imageId", async (req, reply) => {
    try {
      const img = repo.getImage(toInt((req.params as any).imageId, 0));
      if (!img) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "图片不存在" } });
      const p = media.resolvePath(img);
      if (!p) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "图片文件缺失" } });
      const ct = p.endsWith(".webp") ? "image/webp" : p.endsWith(".png") ? "image/png" : p.endsWith(".gif") ? "image/gif" : "image/jpeg";
      return reply.header("content-type", ct).header("cache-control", "public, max-age=86400").send(createReadStream(p));
    } catch (e) { return fail(reply, e); }
  });
  app.get("/api/stats", async () => repo.stats());
  app.get("/api/export/items.json", async (req, reply) => {
    try {
      return reply.header("content-disposition", 'attachment; filename="assetvault-items.json"').send({ exportedAt: new Date().toISOString(), items: repo.exportItems(), avatars: repo.listAvatars() });
    } catch (e) { return fail(reply, e); }
  });
}
