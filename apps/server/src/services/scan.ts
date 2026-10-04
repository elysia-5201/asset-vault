import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { normalizePath, extOf } from "../../../../packages/core/src/pathnorm";
import { identifyFromNames, extractItemIds } from "../../../../packages/core/src/identify";
import type { ContainerKind } from "../../../../packages/core/src/contracts";
import type { Repo } from "../db/repo";

const ARCHIVE_EXT = new Set([".zip", ".7z", ".rar", ".unitypackage"]);
const SKIP_DIR = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".npm-cache", "dist"]);

export interface ScannedFile { path: string; size: number; mtime: string; container: ContainerKind; kind: "archive" | "unitypackage" | "loose_file" }

export interface ScanStats { files: number; dirs: number; bytes: number; filesOut: ScannedFile[]; truncated: boolean }

/** 有界递归扫描：默认深 6、上限 20000 个候选项，超出置 truncated；每 200 项让出事件循环（不阻塞 HTTP）。 */
export async function walkCandidates(rootPath: string, opts: { maxDepth?: number; limit?: number } = {}): Promise<ScanStats> {
  if (!existsSync(rootPath)) throw Object.assign(new Error(`路径不存在: ${rootPath}`), { code: "NOT_FOUND", status: 404 });
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 20000;
  const out: ScannedFile[] = [];
  let files = 0, dirs = 0, bytes = 0, truncated = false, sinceYield = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (truncated) return;
      if (SKIP_DIR.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { dirs++; await walk(p, depth + 1); continue; }
      const ext = extname(name).toLowerCase();
      if (!ARCHIVE_EXT.has(ext)) continue;
      if (out.length >= limit) { truncated = true; return; }
      files++; bytes += st.size;
      out.push({ path: p, size: st.size, mtime: st.mtime.toISOString(), container: ext.slice(1) as ContainerKind, kind: ext === ".unitypackage" ? "unitypackage" : "archive" });
      if (++sinceYield >= 200) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
    }
  };
  await walk(rootPath, 0);
  return { files, dirs, bytes, filesOut: out, truncated };
}

export interface ScanPlanItem {
  title: string; sourceSite: "booth" | "local"; sourceItemId: string | null; confidence: number; method: string | null;
  evidence: string[]; assets: { file: ScannedFile }[];
}

/** 把扫到的文件按"同目录/同 itemId"归组，产出建条目计划（不落库，便于测试）。 */
export function planFromFiles(rootPath: string, files: ScannedFile[]): ScanPlanItem[] {
  const groups = new Map<string, ScanPlanItem>();
  const rootPrefix = rootPath.replace(/[\\/]+$/, "");
  for (const f of files) {
    const rel = f.path.startsWith(rootPrefix) ? f.path.slice(rootPrefix.length).replace(/^[\\/]+/, "") : f.path;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.pop() ?? f.path;
    const ancestors = parts; // 相对扫描根的上层目录名（商品号可能在任意一层）
    const id = identifyFromNames([fileName, ...ancestors], []);
    const best = id.best;
    // 有商品号 → 按商品号归并；无商品号 → 一个压缩包一个条目（不再把整个目录当一个商品）
    const key = best ? `booth:${best.itemId}` : `local:${normalizePath(f.path)}`;
    let g = groups.get(key);
    if (!g) {
      const idDir = best ? ancestors.find((p) => p.includes(best.itemId)) : undefined;
      const title = (idDir ?? fileName).replace(/\.[^.]+$/, "").trim() || fileName;
      g = {
        title,
        sourceSite: best ? "booth" : "local",
        sourceItemId: best?.itemId ?? null,
        confidence: best?.confidence ?? 0,
        method: best?.method ?? null,
        evidence: best?.evidence ?? [],
        assets: [],
      };
      groups.set(key, g);
    }
    g.assets.push({ file: f });
  }
  return [...groups.values()];
}

/** 把文件登记为资产（path_norm 去重），返回新建/更新的资产与新增数。 */
export function registerAssets(repo: Repo, rootId: number, path: string, itemId: number, f: ScannedFile, discoveredBy: "scan" | "watch" | "download" | "manual"): { id: number; created: boolean } {
  const r = repo.upsertAsset({
    item_id: itemId, kind: f.kind, container: f.container, path: f.path,
    path_norm: normalizePath(f.path), root_id: rootId, size: f.size, mtime: f.mtime, discovered_by: discoveredBy,
  });
  void extOf; void extractItemIds;
  return { id: r.asset.id, created: r.created };
}