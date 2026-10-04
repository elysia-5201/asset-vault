import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, readFileSync, statSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { listArchive } from "../../../../packages/core/src/archive/list";
import { listUnityPackage } from "../../../../packages/core/src/unitypackage";
import { basename, extname } from "node:path";
import { normalizePath } from "../../../../packages/core/src/pathnorm";
import { BoothClient, parseBoothUrl } from "../../../../packages/core/src/source/booth";
import { walkCandidates, registerAssets } from "../services/scan";
import { matchItem } from "../services/match";
import { indexAsset } from "../services/indexing";
import type { Repo } from "../db/repo";
import type { MediaStore } from "../services/media";
import type { JobRunner } from "../jobs/runner";
import { listWatches, setWatches } from "../services/watcher";
import type { InboxWatcher } from "../services/watcher";
import { toInt } from "../util";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { parseProtocolUrl, downloadBoothFile, isAllowedBoothUrl } from "../services/download";
import { importBoothUrl } from "../services/booth";
import { UnityMcp, UNITY_MCP_URLS, unityEditorInfo, listUnityPackageCandidates, stageUnityPackage, importPackagesIntoUnity, readUnityConsole, clearUnityConsole, matchAvatarByText, setUnityLogger, baseName, sleep } from "../services/unity";

export interface RouteDeps { repo: Repo; media: MediaStore; booth: BoothClient; runner: JobRunner; watcher?: InboxWatcher; log: (m: string) => void; version: string; dbPath: string; dataDir: string }

const DEFAULT_DOWNLOAD_SUBDIR = "downloads";
function downloadRootOf(repo: Repo, dataDir: string): string {
  const saved = repo.getSetting("download_root");
  if (saved && saved.trim()) return saved.trim();
  return join(dataDir, DEFAULT_DOWNLOAD_SUBDIR);
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  const err = e as any;
  const status = typeof err?.status === "number" ? err.status : Array.isArray(err?.statusCode) ? 400 : 500;
  const code = err?.code && typeof err.code === "string" ? err.code : status === 500 ? "INTERNAL" : "INVALID_INPUT";
  if (status >= 500) deps_log(String(err?.stack ?? err));
  return reply.status(status).send({ error: { code, message: String(err?.message ?? err) } });
}
let deps_log: (m: string) => void = () => {};

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
      const q = req.query as any;
      const avatarIds = String(q.avatar ?? "").split(",").map((s) => toInt(s, NaN)).filter((n) => Number.isFinite(n));
      return repo.listItems({
        q: q.q, avatarIds, avatarMatch: q.avatarMatch === "all" ? "all" : "any", ownedOnly: q.ownedOnly === "1" || q.ownedOnly === "true",
        site: q.site, status: q.status, tag: q.tag, container: q.container,
        imported: q.imported === "1" || q.imported === "true" ? true : q.imported === "0" || q.imported === "false" ? false : undefined,
        collectionId: q.collection ? toInt(q.collection, 0) || undefined : undefined,
        sort: q.sort === "title" || q.sort === "size" ? q.sort : "updated",
        limit: toInt(q.limit, 60), offset: toInt(q.offset, 0),
      });
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/items/:id", async (req, reply) => {
    try {
      const d = repo.getItem(toInt((req.params as any).id, 0));
      if (!d) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "条目不存在" } });
      return { ...d, updates: repo.listUpdates(d.id) };
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/items", async (req, reply) => {
    try {
      const b = req.body as any;
      if (!b?.title) return reply.status(400).send({ error: { code: "INVALID_INPUT", message: "title 必填" } });
      let sourceSite: any = "local"; let sourceItemId: string | null = null;
      if (b.sourceUrl) { const p = parseBoothUrl(String(b.sourceUrl)); if (p) { sourceSite = "booth"; sourceItemId = p.itemId; } }
      return repo.createItem({ title: String(b.title), source_site: sourceSite, source_item_id: sourceItemId, source_url: b.sourceUrl ?? null, notes: b.notes ?? null, status: b.status ?? (sourceItemId ? "active" : "inbox") });
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
      const remaining = detail.tags.filter((t) => {
        const [ns, name] = t.includes(":") ? [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] : [null, t];
        const row = (repo.listTags() as any[]).find((x: any) => x.name === name && (x.namespace ?? null) === ns);
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
      const matched = matchItem(repo, out.itemId, {});
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
      const outcome = matchItem(repo, itemId, {});
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
          const tmpDir = mkdtempSync(join(tmpdir(), "av-upkg-"));
          try {
            for (const c of found) {
              const src = c.innerEntryPath ? c.entryPath + " › " + c.innerEntryPath : (c.entryPath ?? a.path);
              try {
                const staged = await stageUnityPackage(c, tmpDir);
                const listing = await listUnityPackage(staged.path, { maxAssets: 20000 });
                packages.push({ label: c.label, source: src, size: c.size, assets: listing.assets.length, note: c.note });
                for (const x of listing.assets) assets.push({ ...x, package: c.label });
              } catch { packages.push({ label: c.label, source: src, size: c.size, assets: 0 }); }
            }
          } finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
          if (assets.length > 20000) assets = assets.slice(0, 20000);
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
      const { readArchiveEntry } = await import("../../../../packages/core/src/archive/list");
      const buf = await readArchiveEntry(a.path, p, 16 * 1024 * 1024);
      const ext = extname(p).toLowerCase();
      const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : /jpe?g/.test(ext) ? "image/jpeg" : /json|txt|md|meta|yaml|yml/.test(ext) ? "text/plain; charset=utf-8" : "application/octet-stream";
      return reply.header("content-type", ct).send(buf);
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/assets/:id/reindex", async (req, reply) => {
    try {
      const id = toInt((req.params as any).id, 0);
      const a = repo.getAsset(id);
      if (!a) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "资产不存在" } });
      const r = await indexAsset(repo, media, id, { hashMaxBytes: 8 * 1024 * 1024 * 1024 });
      matchItem(repo, a.item_id, {});
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
        return { dryRun: true, path: p, files: stats.files, dirs: stats.dirs, bytes: stats.bytes, truncated: stats.truncated,
          items: plans.map((x) => ({ title: x.title, sourceSite: x.sourceSite, sourceItemId: x.sourceItemId, confidence: x.confidence, assets: x.assets.length })) };
      }
      const j = repo.createJob("scan", null, { path: p, rootId: rootRow?.id ?? null, deep: !!b.deep }, 3);
      return { jobId: j.id, state: j.state };
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
  app.get("/api/tags", async () => ({ tags: repo.listTags() }));
  app.post("/api/tags", async (req, reply) => {
    try { const b = (req.body ?? {}) as any; return { id: repo.ensureTag(String(b.name), b.namespace ?? null, b.color ?? null) }; }
    catch (e) { return fail(reply, e); }
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
      matchItem(repo, targetId, {});
      deps.log("merge: item " + sourceId + " -> " + targetId + " assets=" + r.movedAssets + " images=" + r.movedImages);
      return { ...r, target: repo.getItem(targetId) };
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
  }));
  app.put("/api/settings", async (req, reply) => {
    try {
      const b = (req.body ?? {}) as any;
      if (typeof b.downloadRoot === "string" && b.downloadRoot.trim()) {
        mkdirSync(b.downloadRoot.trim(), { recursive: true });
        repo.setSetting("download_root", b.downloadRoot.trim());
      }
      if (typeof b.unityMcpUrl === "string") repo.setSetting("unity_mcp_url", b.unityMcpUrl.trim());
      return { downloadRoot: downloadRootOf(repo, deps.dataDir), unityMcpUrl: (repo.getSetting("unity_mcp_url") ?? "").trim() };
    } catch (e) { return fail(reply, e); }
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
      const limit = toInt(b?.limit, 100000);
      const rows = repo.listItems({ limit: 100000, includeTrashed: false }) as any;
      let done = 0, errors = 0;
      for (const card of rows.items.slice(0, limit)) {
        try { matchItem(repo, card.id, {}); done++; }
        catch { errors++; }
      }
      return { requeued: done, errors, total: rows.items.length };
    } catch (e) { return fail(reply, e); }
  });

  /** 给"有图但没设封面"的条目补封面（历史数据修复；幂等）。 */
  app.post("/api/admin/fix-covers", async () => {
    const r = repo.fixMissingCovers();
    deps.log("fix-covers: " + r.fixed + " items");
    return r;
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
