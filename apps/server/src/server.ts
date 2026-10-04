import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db/migrate";
import { Repo } from "./db/repo";
import { seedAvatars } from "./db/seed";
import { MediaStore } from "./services/media";
import { JobRunner } from "./jobs/runner";
import { InboxWatcher } from "./services/watcher";
import { registerRoutes } from "./http/routes";
import { BoothClient } from "../../../packages/core/src/source/booth";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface StartOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  version?: string;
  /** 额外日志出口（Electron 里可打到窗口） */
  onLog?: (line: string) => void;
  /** 是否监听端口（Electron 也可只跑服务不监听，默认监听） */
  listen?: boolean;
  /** 打包成单文件 bundle 后，import.meta.url 不再指向源码树：这些路径可显式覆盖 */
  schemaFile?: string;
  seedFile?: string;
  webDistDir?: string;
  logsDir?: string;
}

export interface AssetVaultHandle {
  app: FastifyInstance | null;
  repo: Repo;
  media: MediaStore;
  booth: BoothClient;
  runner: JobRunner;
  watcher: InboxWatcher;
  dataDir: string;
  port: number;
  url: string;
  log: (m: string) => void;
  close: () => Promise<void>;
}

/** 起一个 AssetVault 实例（CLI 与 Electron 共用；Electron 里在同一进程内调用）。 */
export async function startAssetVault(opts: StartOptions = {}): Promise<AssetVaultHandle> {
  const dataDir = opts.dataDir ?? process.env.ASSETVAULT_DATA ?? join(repoRoot, "data");
  const logsDir = opts.logsDir ?? join(repoRoot, "logs");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const dbPath = join(dataDir, "vault.db");
  const mediaDir = join(dataDir, "media");
  const logStream = createWriteStream(join(logsDir, "server.log"), { flags: "a" });
  const log = (m: string) => {
    const line = "[" + new Date().toISOString() + "] " + m;
    logStream.write(line + "\n");
    opts.onLog?.(line);
    if (process.env.ASSETVAULT_VERBOSE) console.log(line);
  };

  const db = openDatabase(dbPath, opts.schemaFile);
  const repo = new Repo(db);
  const seeded = seedAvatars(repo, opts.seedFile);
  const media = new MediaStore(mediaDir);
  const booth = new BoothClient({ minIntervalMs: 700 });
  const recovered = repo.recoverInFlight();

  let app: FastifyInstance | null = null;
  const watcher = new InboxWatcher(repo, log);
  const runner = new JobRunner({ repo, media, booth, log });

  if (opts.listen !== false) {
    const fastify = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
    registerRoutes(fastify, { repo, media, booth, runner, watcher, log, version: opts.version ?? "0.1.0", dbPath, dataDir });
    const distDir = opts.webDistDir ?? join(repoRoot, "apps", "web", "dist");
    if (existsSync(join(distDir, "index.html"))) {
      // wildcard 默认 true：否则 /assets/* 不注册，全部落到 SPA 兜底 → JS 以 text/html 返回导致白屏
      await fastify.register(fastifyStatic, { root: distDir, prefix: "/" });
      fastify.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "no route " + req.url } });
        return reply.sendFile("index.html");
      });
      log("static web served from " + distDir);
    } else {
      fastify.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api/")) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "no route " + req.url } });
        return reply.header("content-type", "text/html; charset=utf-8").send("<!doctype html><meta charset=\"utf-8\"><title>AssetVault</title><body style=\"font:14px/1.6 system-ui;padding:2rem\"><h1>AssetVault API 已就绪</h1><p>前端未构建：npx vite build --config apps/web/vite.config.ts</p>");
      });
    }
    const port = opts.port ?? Number(process.env.PORT ?? 7317);
    const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
    await fastify.listen({ port, host });
    app = fastify;
    runner.start(400);
    watcher.sync();
    log("AssetVault up on http://" + host + ":" + port + " (db=" + dbPath + ", seeded=" + seeded + ", recovered=" + recovered + ")");
    if (process.env.ASSETVAULT_VERBOSE) console.log("AssetVault up on http://" + host + ":" + port);
    return {
      app, repo, media, booth, runner, watcher, dataDir, port, url: "http://" + host + ":" + port, log,
      close: async () => {
        runner.stop();
        try { await watcher.close(); } catch { /* noop */ }
        try { await app?.close(); } catch { /* noop */ }
        try { db.close(); } catch { /* noop */ }
        logStream.end();
      },
    };
  }

  log("AssetVault embedded mode (db=" + dbPath + ", seeded=" + seeded + ")");
  return {
    app: null, repo, media, booth, runner, watcher, dataDir, port: 0, url: "", log,
    close: async () => { runner.stop(); try { await watcher.close(); } catch { /* noop */ } try { db.close(); } catch { /* noop */ } logStream.end(); },
  };
}
