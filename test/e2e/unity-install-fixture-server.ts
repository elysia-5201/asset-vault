/**
 * T5 isolated AssetVault fixture for the Unity install UI.
 *
 * Safety:
 * - dataDir/logsDir must be fresh subdirectories under os.tmpdir(); symlink ancestors,
 *   dangling links, files, and the TMP root itself are rejected before any write.
 * - host is fixed to 127.0.0.1; port 7317 is rejected; port 0 picks an ephemeral port.
 * - the returned handle is this process's own AssetVault instance; close() is idempotent
 *   and removes the SIGINT/SIGTERM handlers it installed.
 * - a process-local fetch guard allows only this fixture's own app/stub origins;
 *   any other origin is rejected before the underlying fetch, so a failed stub
 *   cannot fall through to the user's default 8080/14523 Editor.
 * - the DB path is verified through PRAGMA database_list before ready.
 *
 * This is a synthetic local fixture, not a real Unity/UPM/bridge capability test.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { startAssetVault, type AssetVaultHandle } from "../../apps/server/src/server";

export interface UnityInstallFixtureOptions {
  dataDir: string;
  logsDir: string;
  host?: string;
  port?: number;
}

export interface UnityInstallFixture {
  handle: AssetVaultHandle;
  url: string;
  close: () => Promise<void>;
}

type FetchFn = typeof globalThis.fetch;

const RESERVED_STUB_PORTS = new Set([7317, 8080, 14523]);
export function isReservedStubPort(port: number): boolean {
  return RESERVED_STUB_PORTS.has(port);
}

const activeOrigins = new Set<string>();
let activeFixtures = 0;
let previousFetch: FetchFn | null = null;
let guardFetch: FetchFn | null = null;

function originOf(input: Parameters<FetchFn>[0]): string | null {
  try {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (globalThis as any).Request && input instanceof (globalThis as any).Request
          ? input.url
          : String(input);
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function installFetchGuard(): void {
  if (activeFixtures === 0) {
    previousFetch = globalThis.fetch;
    const next = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
      const origin = originOf(input);
      if (!origin || !activeOrigins.has(origin)) {
        throw new Error("fixture fetch guard blocked origin " + (origin ?? "<invalid>"));
      }
      return previousFetch!(input, init);
    }) as FetchFn;
    guardFetch = next;
    globalThis.fetch = next;
  } else if (globalThis.fetch !== guardFetch) {
    throw new Error("fixture fetch guard was replaced externally");
  }
  activeFixtures++;
}

function releaseFetchGuard(): void {
  if (activeFixtures <= 0) return;
  activeFixtures--;
  if (activeFixtures === 0) {
    if (globalThis.fetch === guardFetch) {
      globalThis.fetch = previousFetch!;
    }
    previousFetch = null;
    guardFetch = null;
    activeOrigins.clear();
  }
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function nearestExisting(abs: string): { existing: string; suffix: string[] } {
  let cur = abs;
  const suffix: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    suffix.unshift(basename(cur));
    cur = parent;
  }
  return { existing: realpathSync(cur), suffix };
}

function assertNoSymlinkComponents(abs: string, tmpReal: string, label: string): void {
  const rel = relative(tmpReal, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(label + " must be under TMP: " + abs);
  }
  let cur = tmpReal;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) break;
    if (st.isSymbolicLink()) throw new Error(label + " must not contain symlink: " + cur);
  }
}

function assertTmpPath(raw: string, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(label + " must be a non-empty path");
  const abs = resolve(raw);
  if (!isAbsolute(abs)) throw new Error(label + " must be absolute");
  const tmpReal = realpathSync(tmpdir());
  if (abs === tmpReal) throw new Error(label + " must be a fresh subdirectory of TMP");
  const { existing, suffix } = nearestExisting(abs);
  const st = statSync(existing);
  if (!st.isDirectory()) throw new Error(label + " parent is not a directory: " + existing);
  const canonical = join(existing, ...suffix);
  if (!isUnder(canonical, tmpReal)) throw new Error(label + " must be under TMP: " + abs);
  assertNoSymlinkComponents(abs, tmpReal, label);
  const self = lstatOrNull(abs);
  if (self && !self.isDirectory()) throw new Error(label + " must be a directory: " + abs);
  return abs;
}

function normalizePort(raw: number | undefined): number {
  const port = raw ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
  if (port === 7317) throw new Error("port 7317 is reserved for the user app");
  return port;
}

/**
 * Synthetic loopback MCP stub. It is NOT a real Unity bridge: it only answers
 * initialize/tools/list/execute_code with a fixed TMP editor path. The fixture
 * fetch guard blocks any fallback to the user's default 8080/14523 Editor.
 */
async function startMcpStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let msg: any;
      try { msg = JSON.parse(body); } catch { res.statusCode = 400; res.end(); return; }
      const id = msg?.id;
      const method = msg?.method;
      const json = (payload: unknown): void => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (method === "initialize") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "fixture-session");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fixture-mcp", version: "0.0.0" } } }));
        return;
      }
      if (method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (method === "tools/list") {
        json({ jsonrpc: "2.0", id, result: { tools: [{ name: "execute_code", inputSchema: { type: "object", properties: { action: { type: "string" }, code: { type: "string" }, safety_checks: { type: "boolean" } } } }] } });
        return;
      }
      if (method === "tools/call") {
        if (msg?.params?.name !== "execute_code") {
          json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "unsupported tool" }] } });
          return;
        }
        const result = "/tmp/av-unity-fixture-editor/Assets|/tmp/av-unity-fixture-editor|2021.3.22f1|0|0|Assets/Scene.unity";
        json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }], structuredContent: { success: true, data: { result } } } });
        return;
      }
      json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("MCP stub address unavailable");
  if (isReservedStubPort(addr.port)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("MCP stub port " + addr.port + " is reserved");
  }
  return {
    url: "http://127.0.0.1:" + addr.port + "/mcp",
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export async function startUnityInstallFixture(opts: UnityInstallFixtureOptions): Promise<UnityInstallFixture> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("host must be 127.0.0.1");
  const port = normalizePort(opts.port);
  const dataDir = assertTmpPath(opts.dataDir, "dataDir");
  const logsDir = assertTmpPath(opts.logsDir, "logsDir");
  if (dataDir === logsDir) throw new Error("dataDir and logsDir must be different");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  let handle: AssetVaultHandle | null = null;
  let mcp: { url: string; close: () => Promise<void> } | null = null;
  let closed = false;
  let guardInstalled = false;
  const origins = new Set<string>();
  const release = (): void => {
    if (!guardInstalled) return;
    guardInstalled = false;
    for (const origin of origins) activeOrigins.delete(origin);
    origins.clear();
    releaseFetchGuard();
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      if (handle) await handle.close();
    } finally {
      try {
        if (mcp) await mcp.close();
      } finally {
        release();
      }
    }
  };
  const onSignal = (): void => { void close().catch(() => {}); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    installFetchGuard();
    guardInstalled = true;
    mcp = await startMcpStub();
    const stubOrigin = new URL(mcp.url).origin;
    origins.add(stubOrigin);
    activeOrigins.add(stubOrigin);

    const h = await startAssetVault({ dataDir, logsDir, host, port, listen: true, version: "test" });
    handle = h;
    h.repo.setSetting("unity_mcp_url", mcp.url);
    if (!h.app) throw new Error("fixture server did not listen");
    const addr = h.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("fixture server address unavailable");
    const actualPort = addr.port;
    if (actualPort === 7317) throw new Error("fixture server must not use 7317");
    const appOrigin = "http://" + host + ":" + actualPort;
    origins.add(appOrigin);
    activeOrigins.add(appOrigin);
    const dbPath = join(dataDir, "vault.db");
    if (!existsSync(dbPath)) throw new Error("fixture DB missing: " + dbPath);
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.pragma("database_list") as Array<{ file?: string }>;
      const actual = rows
        .map((r) => r.file)
        .filter((f): f is string => typeof f === "string" && f.length > 0)
        .map((f) => realpathSync(f));
      if (!actual.includes(realpathSync(dbPath))) throw new Error("fixture DB path mismatch");
    } finally {
      db.close();
    }
    return { handle: h, url: "http://" + host + ":" + actualPort, close };
  } catch (e) {
    try { await close(); } catch { /* preserve the original startup error */ }
    throw e;
  }
}

/** Optional CLI for the native validator: prints one JSON line, then waits for SIGINT/SIGTERM. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataDir = get("--data-dir");
  const logsDir = get("--logs-dir");
  if (!dataDir || !logsDir) {
    console.error("usage: unity-install-fixture-server --data-dir DIR --logs-dir DIR [--port N]");
    process.exit(2);
  }
  const port = get("--port") ? Number(get("--port")) : 0;
  startUnityInstallFixture({ dataDir, logsDir, host: "127.0.0.1", port })
    .then((f) => {
      console.log(JSON.stringify({ url: f.url, dataDir: f.handle.dataDir, pid: process.pid }));
      const stop = async (): Promise<void> => { await f.close(); process.exit(0); };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
    })
    .catch((e) => {
      console.error(String((e as Error)?.message ?? e));
      process.exit(1);
    });
}
