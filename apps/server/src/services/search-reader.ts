import Database from "better-sqlite3";
import { parentPort, type Worker } from "node:worker_threads";
import { AppError, type AppErrorCode } from "../../../../packages/core/src/contracts";
import { Repo, type ItemQuery } from "../db/repo";
import { compileSearch, searchSuggestions } from "./search";
import { createSearchWorker, searchIndexStatus } from "./search-index";

type SearchTask = { kind: "items" | "counts" | "alternatives"; query: ItemQuery }
  | { kind: "facets"; query: ItemQuery; dimension: Parameters<Repo["searchFacets"]>[1] }
  | { kind: "suggestions"; input: string };

export function runSearchRead(repo: Repo, task: SearchTask) {
  switch (task.kind) {
    case "items": return repo.listItems(task.query);
    case "counts": return repo.categoryCounts(task.query);
    case "facets": return { dimension: task.dimension, options: repo.searchFacets(task.query, task.dimension) };
    case "suggestions": return { suggestions: searchSuggestions(repo.connection, task.input) };
    case "alternatives": {
      const raw = task.query.q ?? "";
      const filters = raw ? compileSearch(repo.connection, raw).query.filters : [];
      const relaxations = filters.filter((f) => f.field !== "avatar").slice(0, 4).map((f) => {
        const next = (raw.slice(0, f.start) + " " + raw.slice(f.end)).trim();
        return { query: next, removed: raw.slice(f.start, f.end), count: repo.listItems({ ...task.query, q: next, limit: 1 }).total };
      });
      return { relaxations, index: searchIndexStatus(repo.connection) };
    }
  }
}

type SearchResult = ReturnType<typeof runSearchRead>;
type SearchReply = { id: number; result: SearchResult } | { id: number; error: { message: string; code?: AppErrorCode; status?: number } };
const readCaches = new WeakMap<Repo, { revision: string; responses: Map<string, SearchResult> }>();

export function runCachedSearchRead(repo: Repo, task: SearchTask): SearchResult {
  const db = repo.connection;
  const revision = [db.pragma("data_version", { simple: true }), db.prepare("SELECT total_changes()").pluck().get(),
    Math.floor(Date.now() / 60_000)].join(":");
  let cache = readCaches.get(repo);
  if (!cache || cache.revision !== revision) {
    cache = { revision, responses: new Map() };
    readCaches.set(repo, cache);
  }
  const key = JSON.stringify(task);
  const previous = cache.responses.get(key);
  if (previous) {
    cache.responses.delete(key);
    cache.responses.set(key, previous);
    return previous;
  }
  const result = runSearchRead(repo, task);
  if (cache.responses.size >= 24) cache.responses.delete(cache.responses.keys().next().value!);
  if (task.kind !== "items" || (task.query.limit ?? 60) <= 120) cache.responses.set(key, result);
  return result;
}

export function runSearchReadWorker(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 200 });
  db.pragma("query_only=ON");
  const repo = new Repo(db);
  const read = db.transaction((task: SearchTask) => runCachedSearchRead(repo, task));
  parentPort?.on("message", ({ id, task }: { id: number; task: SearchTask }) => {
    let reply: SearchReply;
    try { reply = { id, result: read(task) }; }
    catch (error) {
      const e = error as AppError;
      reply = { id, error: { message: e.message, code: e.code, status: e.status } };
    }
    parentPort?.postMessage(reply);
  });
}

interface QueuedRead {
  id: number; task: SearchTask; resolve: (value: SearchResult) => void; reject: (reason: unknown) => void; detach: () => void;
}

/** At most one active SQLite query and 32 queued reads in the search worker. */
export class SearchReader {
  private worker: Worker | undefined;
  private queue: QueuedRead[] = [];
  private active: QueuedRead | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private entry: string, private file: string, private log: (message: string) => void) {}

  private start() {
    const worker = createSearchWorker(this.entry, this.file, "runSearchReadWorker");
    worker.on("message", (message: SearchReply) => {
      const request = this.active;
      if (request?.id !== message.id) return;
      this.active = undefined;
      request.detach();
      if ("result" in message) request.resolve(message.result);
      else request.reject(message.error.status ? new AppError(message.error.code ?? "INVALID_INPUT", message.error.message, message.error.status)
        : new Error(message.error.message));
      this.pump();
    });
    worker.on("error", (error) => this.log("search reader: " + error.message));
    worker.once("exit", () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.rejectPending(new AppError("UPSTREAM_ERROR", "搜索线程已退出，请重试", 503));
    });
    worker.unref();
    this.worker = worker;
  }

  private rejectPending(error: Error) {
    for (const request of [...(this.active ? [this.active] : []), ...this.queue]) {
      request.detach();
      request.reject(error);
    }
    this.active = undefined;
    this.queue = [];
  }

  private pump() {
    if (this.active || !this.queue.length || this.closed) return;
    if (!this.worker) this.start();
    this.active = this.queue.shift()!;
    this.worker!.postMessage({ id: this.active.id, task: this.active.task });
  }

  read(task: SearchTask, signal: AbortSignal): Promise<SearchResult> {
    if (this.closed || this.queue.length >= 32) return Promise.reject(new AppError("UPSTREAM_ERROR", "搜索队列繁忙，请重试", 503));
    if (signal.aborted) return Promise.reject(new AppError("INVALID_INPUT", "搜索已取消", 499));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const abort = () => {
        this.queue = this.queue.filter((request) => request.id !== id);
        reject(new AppError("INVALID_INPUT", "搜索已取消", 499));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push({ id, task, resolve, reject, detach: () => signal.removeEventListener("abort", abort) });
      this.pump();
    });
  }

  async close() {
    this.closed = true;
    this.rejectPending(new AppError("UPSTREAM_ERROR", "搜索服务已关闭", 503));
    await this.worker?.terminate();
  }
}
