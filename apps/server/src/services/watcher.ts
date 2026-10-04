import chokidar, { type FSWatcher } from "chokidar";
import { extname } from "node:path";
import type { Repo } from "../db/repo";

export interface WatchEntry { path: string; enabled: boolean }
const KEY = "watch_paths";
const ARCHIVE_EXT = new Set([".zip", ".7z", ".rar", ".unitypackage"]);

export function listWatches(repo: Repo): WatchEntry[] {
  const raw = repo.getSetting(KEY);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr.filter((x: any) => x && typeof x.path === "string") : []; } catch { return []; }
}
export function setWatches(repo: Repo, entries: WatchEntry[]): void { repo.setSetting(KEY, JSON.stringify(entries)); }

/** 收件箱监听：新落盘的压缩包/unitypackage 自动建条目并排队（贴合"IDM 下完就不管了"的习惯）。 */
export class InboxWatcher {
  private watchers = new Map<string, FSWatcher>();
  constructor(private repo: Repo, private log: (m: string) => void) {}

  sync(): void {
    const want = listWatches(this.repo).filter((e) => e.enabled);
    for (const [p, w] of this.watchers) {
      if (!want.some((e) => e.path === p)) { void w.close(); this.watchers.delete(p); this.log(`watch removed: ${p}`); }
    }
    for (const e of want) {
      if (this.watchers.has(e.path)) continue;
      try {
        const w = chokidar.watch(e.path, { depth: 3, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }, usePolling: true });
        w.on("add", (file) => this.onFile(file));
        w.on("error", (err) => this.log(`watch error ${e.path}: ${String(err)}`));
        this.watchers.set(e.path, w);
        this.log(`watching inbox: ${e.path}`);
      } catch (err) { this.log(`watch failed ${e.path}: ${String(err)}`); }
    }
  }
  private onFile(file: string): void {
    if (!ARCHIVE_EXT.has(extname(file).toLowerCase())) return;
    const job = this.repo.createJob("import_file", null, { path: file }, 4);
    this.log(`inbox: new file ${file} -> job ${job.id} (${job.state})`);
  }
  async close(): Promise<void> { for (const w of this.watchers.values()) await w.close(); this.watchers.clear(); }
}
