/**
 * Feature 123 isolated fixture launcher.
 *
 * Contract (task-5 brief 68-74 + planning/errata/report.md):
 * - exactly two argv: an absolute FIXTURE_DIR under os.tmpdir() and a numeric PORT;
 * - reject missing args, non-tmp dirs, repo data/logs (including aliases), non-empty
 *   reused dirs, invalid ports and 7317 with exit 2 BEFORE startAssetVault;
 * - seed a synthetic vault.db/media/avatar/item/asset inside FIXTURE_DIR;
 * - start with explicit host/dataDir/logsDir/port/version;
 * - postcheck handle.dataDir/port/url and PRAGMA database_list, close + exit 3 on mismatch;
 * - print FIXTURE_OK only after every check passes.
 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../apps/server/src/db/migrate";
import { startAssetVault, type AssetVaultHandle, type StartOptions } from "../../apps/server/src/server";

export const FIXTURE_HOST = "127.0.0.1";
export const FIXTURE_VERSION = "fixture";
export const FORBIDDEN_PORT = 7317;

export interface FixturePlan {
  fixtureDir: string;
  port: number;
  dbPath: string;
  mediaDir: string;
  logsDir: string;
}

export class PreflightError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

/**
 * Resolve the nearest genuinely existing ancestor, then append the missing suffix.
 * A missing component is only accepted when lstat says ENOENT; an existing but
 * unresolvable ancestor (dangling link, ELOOP, EACCES, ENOTDIR) fails closed.
 */
function canonicalPath(p: string): string {
  const absolute = resolve(p);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      lstatSync(current);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) {
          throw new PreflightError("cannot resolve fixture dir: no existing ancestor for " + absolute);
        }
        missing.unshift(basename(current));
        current = parent;
        continue;
      }
      throw new PreflightError("cannot inspect fixture dir ancestor " + current + ": " + (e as Error).message);
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch (e) {
      throw new PreflightError("fixture dir ancestor is not resolvable: " + current + " (" + (e as Error).message + ")");
    }
    return missing.length > 0 ? join(real, ...missing) : real;
  }
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function preflight(argv: string[]): FixturePlan {
  if (argv.length !== 2) {
    throw new PreflightError("usage: feature123-fixture-server.ts <absolute-tmp-dir> <port>");
  }
  const [rawDir, rawPort] = argv;
  if (!rawDir || !rawPort) {
    throw new PreflightError("missing fixture dir or port");
  }
  if (!isAbsolute(rawDir)) {
    throw new PreflightError("fixture dir must be absolute: " + rawDir);
  }

  const fixtureDir = resolve(rawDir);
  const tmpRoot = canonicalPath(tmpdir());
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const repoData = resolve(repoRoot, "data");
  const repoLogs = resolve(repoRoot, "logs");
  const canonicalFixture = canonicalPath(fixtureDir);
  const canonicalRepoData = canonicalPath(repoData);
  const canonicalRepoLogs = canonicalPath(repoLogs);

  for (const [label, repoPath, canonicalRepoPath] of [
    ["data", repoData, canonicalRepoData],
    ["logs", repoLogs, canonicalRepoLogs],
  ] as const) {
    if (isInsideOrEqual(fixtureDir, repoPath) || isInsideOrEqual(canonicalFixture, canonicalRepoPath)) {
      throw new PreflightError("fixture dir must not be repo " + label + " or an alias of it: " + fixtureDir);
    }
  }
  if (canonicalFixture === tmpRoot || !isInsideOrEqual(canonicalFixture, tmpRoot)) {
    throw new PreflightError("fixture dir must be a fresh directory under " + tmpRoot + ": " + fixtureDir);
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new PreflightError("port must be an integer: " + rawPort);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PreflightError("port out of range: " + rawPort);
  }
  if (port === FORBIDDEN_PORT) {
    throw new PreflightError("port " + FORBIDDEN_PORT + " is reserved for the running app");
  }

  let st: Stats | undefined;
  try {
    st = lstatSync(fixtureDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PreflightError("cannot inspect fixture dir: " + (e as Error).message);
    }
  }
  if (st) {
    if (st.isSymbolicLink()) {
      throw new PreflightError("fixture dir must not be a symlink: " + fixtureDir);
    }
    if (!st.isDirectory()) {
      throw new PreflightError("fixture dir is not a directory: " + fixtureDir);
    }
    if (readdirSync(fixtureDir).length > 0) {
      throw new PreflightError("fixture dir must be empty (fresh): " + fixtureDir);
    }
  } else {
    mkdirSync(fixtureDir, { recursive: true });
    const createdCanonical = canonicalPath(fixtureDir);
    if (createdCanonical !== canonicalFixture) {
      throw new PreflightError("fixture dir canonical path changed during creation: " + createdCanonical + " != " + canonicalFixture);
    }
  }

  return {
    fixtureDir,
    port,
    dbPath: join(fixtureDir, "vault.db"),
    mediaDir: join(fixtureDir, "media"),
    logsDir: join(fixtureDir, "logs"),
  };
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function seedFixture(plan: FixturePlan): void {
  mkdirSync(plan.mediaDir, { recursive: true });
  mkdirSync(plan.logsDir, { recursive: true });
  const libraryDir = join(plan.fixtureDir, "library");
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(join(plan.mediaDir, "fixture.png"), PNG_1X1);
  // P1-T5：真实可预检/可关联的单个文件（不登记 asset 行，保持既有 assets=1 断言）。
  // 浏览器端「预检 → 关联到既有条目 → 版本关系」主流程需要真实文件路径。
  writeFileSync(join(libraryDir, "incoming.zip"), Buffer.from("PK\u0003\u0004fixture-incoming", "utf8"));

  const db = openDatabase(plan.dbPath);
  try {
    const now = new Date().toISOString();
    const rootId = Number(
      db.prepare("INSERT INTO library_roots(path,path_norm,created_at) VALUES (?,?,?)")
        .run(libraryDir, libraryDir, now).lastInsertRowid,
    );
    const avatarId = Number(
      db.prepare("INSERT INTO avatars(name,name_norm,created_at,updated_at) VALUES (?,?,?,?)")
        .run("Fixture Avatar", "fixture avatar", now, now).lastInsertRowid,
    );
    const itemId = Number(
      db.prepare("INSERT INTO items(uid,source_site,title,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run("fixture-item-1", "local", "Fixture Item", now, now).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO assets(item_id,kind,container,path,path_norm,root_id,discovered_by,first_seen) VALUES (?,?,?,?,?,?,?,?)",
    ).run(itemId, "archive", "zip", join(libraryDir, "fixture.zip"), join(libraryDir, "fixture.zip"), rootId, "scan", now);
    db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,?,?,?)")
      .run(itemId, avatarId, "any", 1, "manual");
    db.prepare("INSERT INTO settings(key,value) VALUES ('avatars_seeded','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run();
  } finally {
    db.close();
  }
}

export function verifyHandle(handle: AssetVaultHandle, plan: FixturePlan): string[] {
  const problems: string[] = [];
  if (handle.dataDir !== plan.fixtureDir) {
    problems.push("dataDir=" + handle.dataDir + " expected=" + plan.fixtureDir);
  }
  if (handle.port !== plan.port) {
    problems.push("port=" + handle.port + " expected=" + plan.port);
  }
  const expectedUrl = "http://" + FIXTURE_HOST + ":" + plan.port;
  if (handle.url !== expectedUrl) {
    problems.push("url=" + handle.url + " expected=" + expectedUrl);
  }
  let dbFile: string | undefined;
  try {
    const rows = handle.repo.connection.prepare("PRAGMA database_list").all() as Array<{ name?: string; file?: string }>;
    dbFile = rows.find((row) => row.name === "main")?.file;
  } catch (e) {
    problems.push("PRAGMA database_list failed: " + (e as Error).message);
  }
  if (dbFile !== plan.dbPath) {
    problems.push("db=" + dbFile + " expected=" + plan.dbPath);
  }
  return problems;
}

export interface RunDeps {
  start: (opts: StartOptions) => Promise<AssetVaultHandle>;
  exit: (code: number) => never;
  out: (line: string) => void;
  err: (line: string) => void;
  wait: (handle: AssetVaultHandle) => Promise<void>;
}

function waitForShutdown(_handle: AssetVaultHandle): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
      resolvePromise();
    };
    process.on("SIGTERM", done);
    process.on("SIGINT", done);
  });
}

const defaultDeps: RunDeps = {
  start: startAssetVault,
  exit: (code) => process.exit(code),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  wait: waitForShutdown,
};

export async function run(argv: string[], deps: Partial<RunDeps> = {}): Promise<void> {
  const d: RunDeps = { ...defaultDeps, ...deps };

  let plan: FixturePlan;
  try {
    plan = preflight(argv);
  } catch (e) {
    d.err("fixture preflight failed: " + (e as Error).message);
    d.exit(2);
    return;
  }

  try {
    seedFixture(plan);
  } catch (e) {
    d.err("fixture seed failed: " + (e as Error).message);
    d.exit(1);
    return;
  }

  let handle: AssetVaultHandle;
  try {
    handle = await d.start({
      port: plan.port,
      host: FIXTURE_HOST,
      dataDir: plan.fixtureDir,
      logsDir: plan.logsDir,
      version: FIXTURE_VERSION,
    });
  } catch (e) {
    d.err("fixture start failed: " + (e as Error).message);
    d.exit(1);
    return;
  }

  const problems = verifyHandle(handle, plan);
  if (problems.length > 0) {
    try {
      await handle.close();
    } catch {
      /* best effort: the handle is ours and must not leak */
    }
    d.err("fixture postcheck failed: " + problems.join("; "));
    d.exit(3);
    return;
  }

  const shutdown = d.wait(handle);
  d.out("FIXTURE_OK dataDir=" + plan.fixtureDir + " dbPath=" + plan.dbPath + " port=" + plan.port);
  await shutdown;
  await handle.close();
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (invoked === self) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
