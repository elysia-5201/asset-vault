import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { preflight, run, type FixturePlan, type RunDeps } from "./feature123-fixture-server";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const launcherPath = join(repoRoot, "test", "e2e", "feature123-fixture-server.ts");

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function holdPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function runToExit(args: string[], timeoutMs = 20000, env: NodeJS.ProcessEnv = process.env): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", launcherPath, ...args], {
      cwd: repoRoot,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("launcher timeout; stdout=" + stdout + " stderr=" + stderr));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function runNodeScript(script: string, args: string[], timeoutMs = 20000): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("script timeout; stdout=" + stdout + " stderr=" + stderr));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

interface LiveLauncher {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  waitForOk: (timeoutMs?: number) => Promise<string>;
}

function spawnLauncher(args: string[], env: NodeJS.ProcessEnv = process.env): LiveLauncher {
  const child = spawn(process.execPath, ["--import", "tsx", launcherPath, ...args], {
    cwd: repoRoot,
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => { stdout += d; });
  child.stderr.on("data", (d: string) => { stderr += d; });
  const waitForOk = (timeoutMs = 30000): Promise<string> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("no FIXTURE_OK; stdout=" + stdout + " stderr=" + stderr));
    }, timeoutMs);
    const check = (): void => {
      const m = stdout.match(/^FIXTURE_OK .*$/m);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout.on("data", check);
    check();
  });
  return { child, stdout: () => stdout, stderr: () => stderr, waitForOk };
}

function waitExit(child: ChildProcessWithoutNullStreams, timeoutMs = 15000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child did not exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForFileMatch(file: string, re: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { last = readFileSync(file, "utf8"); } catch { last = ""; }
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("file did not match " + re + ": " + last);
}

function makeHandle(plan: FixturePlan, overrides: Record<string, unknown> = {}): { handle: any; closed: () => boolean } {
  let closed = false;
  const handle: any = {
    dataDir: plan.fixtureDir,
    port: plan.port,
    url: "http://127.0.0.1:" + plan.port,
    repo: {
      connection: {
        prepare: () => ({ all: () => [{ seq: 0, name: "main", file: plan.dbPath }] }),
      },
    },
    close: async () => { closed = true; },
    ...overrides,
  };
  return { handle, closed: () => closed };
}

test("preflight rejects missing arguments with exit 2", async () => {
  const r = await runToExit([]);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
  assert.match(r.stderr, /usage|missing/i);
});

test("preflight rejects a relative fixture dir with exit 2", async () => {
  const r = await runToExit(["relative-fixture", "7391"]);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
});

test("preflight rejects a dir outside os.tmpdir with exit 2", async () => {
  const outside = join(repoRoot, "test", "e2e", "not-a-tmp-fixture");
  const r = await runToExit([outside, "7391"]);
  assert.equal(r.code, 2);
  assert.equal(existsSync(outside), false);
  assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
});

test("preflight rejects repo data and logs dirs with exit 2", async () => {
  for (const p of [join(repoRoot, "data"), join(repoRoot, "logs")]) {
    const r = await runToExit([p, "7391"]);
    assert.equal(r.code, 2, p);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
    assert.match(r.stderr, /repo (data|logs)/, p);
  }
});

test("preflight rejects a non-empty reused dir with exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "av-e2e-nonempty-"));
  try {
    writeFileSync(join(dir, "keep.txt"), "x");
    const r = await runToExit([dir, "7391"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rejects port 7317 with exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "av-e2e-port-"));
  try {
    const r = await runToExit([dir, "7317"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rejects invalid ports with exit 2", async () => {
  for (const port of ["0", "65536", "abc", "-1"]) {
    const dir = mkdtempSync(join(tmpdir(), "av-e2e-badport-"));
    try {
      const r = await runToExit([dir, port]);
      assert.equal(r.code, 2, "port=" + port);
      assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("preflight rejects a symlink alias of repo data with exit 2", async () => {
  const parent = mkdtempSync(join(tmpdir(), "av-e2e-alias-"));
  const alias = join(parent, "alias");
  try {
    symlinkSync(join(repoRoot, "data"), alias, "dir");
    const r = await runToExit([alias, "7391"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
    assert.match(r.stderr, /repo data|alias/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("launcher starts a real isolated fixture and serves synthetic rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "av-e2e-live-"));
  const port = await freePort();
  const live = spawnLauncher([dir, String(port)]);
  try {
    const ok = await live.waitForOk();
    assert.match(ok, new RegExp("dataDir=" + escapeRegExp(dir)));
    assert.match(ok, new RegExp("dbPath=" + escapeRegExp(join(dir, "vault.db"))));
    assert.match(ok, new RegExp("port=" + port));
    assert.equal(existsSync(join(dir, "vault.db")), true);
    assert.equal(existsSync(join(dir, "logs", "server.log")), true);
    await waitForFileMatch(join(dir, "logs", "server.log"), /AssetVault up/);
    const png = readFileSync(join(dir, "media", "fixture.png"));
    assert.equal(png.readUInt32BE(16), 1);
    assert.equal(png.readUInt32BE(20), 1);
    const avatars = await fetch("http://127.0.0.1:" + port + "/api/avatars");
    assert.equal(avatars.status, 200);
    assert.match(await avatars.text(), /Fixture Avatar/);
    const items = await fetch("http://127.0.0.1:" + port + "/api/items");
    assert.equal(items.status, 200);
    assert.match(await items.text(), /Fixture Item/);
    const db = new Database(join(dir, "vault.db"), { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number };
      assert.equal(row.n, 1);
    } finally {
      db.close();
    }
    assert.equal(live.child.exitCode, null);
    live.child.kill("SIGTERM");
    const exit = await waitExit(live.child);
    assert.equal(exit.code, 0);
  } finally {
    if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postcheck accepts a matching handle and prints FIXTURE_OK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "av-e2e-match-"));
  const port = await freePort();
  try {
    const plan = preflight([dir, String(port)]);
    const { handle, closed } = makeHandle(plan);
    const out: string[] = [];
    let exitCode: number | null = null;
    const deps: Partial<RunDeps> = {
      start: async () => handle,
      exit: ((code: number) => { exitCode = code; throw new Error("exit " + code); }) as any,
      out: (line) => { out.push(line); },
      err: () => {},
      wait: async () => {},
    };
    await run([dir, String(port)], deps);
    assert.equal(exitCode, null);
    assert.equal(closed(), true);
    assert.match(out.join("\n"), /^FIXTURE_OK /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postcheck closes its own handle and exits 3 on each mismatch", async () => {
  const cases: Array<[string, (plan: FixturePlan) => Record<string, unknown>]> = [
    ["dataDir", (plan) => ({ dataDir: join(plan.fixtureDir, "wrong") })],
    ["port", (plan) => ({ port: plan.port + 1 })],
    ["url", (plan) => ({ url: "http://127.0.0.1:1" })],
    ["db", (plan) => ({
      repo: {
        connection: {
          prepare: () => ({ all: () => [{ seq: 0, name: "main", file: join(plan.fixtureDir, "other.db") }] }),
        },
      },
    })],
  ];
  for (const [name, overrides] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "av-e2e-mismatch-"));
    const port = await freePort();
    try {
      const plan = preflight([dir, String(port)]);
      const { handle, closed } = makeHandle(plan, overrides(plan));
      let exitCode: number | null = null;
      const out: string[] = [];
      const err: string[] = [];
      const deps: Partial<RunDeps> = {
        start: async () => handle,
        exit: ((code: number) => { exitCode = code; throw new Error("exit " + code); }) as any,
        out: (line) => { out.push(line); },
        err: (line) => { err.push(line); },
        wait: async () => {},
      };
      await assert.rejects(() => run([dir, String(port)], deps), /exit 3/, name);
      assert.equal(exitCode, 3, name);
      assert.equal(closed(), true, name);
      assert.equal(out.join("\n").includes("FIXTURE_OK"), false, name);
      assert.match(err.join("\n"), /postcheck failed/, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("preflight rejects a symlinked ancestor with missing nested parents before creating outside", async () => {
  const base = mkdtempSync(join(tmpdir(), "av-e2e-canon-"));
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  mkdirSync(allowed);
  mkdirSync(outside);
  symlinkSync(outside, join(allowed, "link"), "dir");
  const requested = join(allowed, "link", "a", "b");
  const held = await holdPort();
  try {
    const r = await runToExit([requested, String(held.port)], 20000, { ...process.env, TMPDIR: allowed });
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
    assert.match(r.stderr, /must be a fresh directory under/);
    assert.equal(existsSync(join(outside, "a")), false);
    assert.equal(existsSync(join(outside, "a", "b")), false);
    assert.equal(existsSync(join(outside, "vault.db")), false);
  } finally {
    await held.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("preflight accepts a legitimate absent nested path under TMP", async () => {
  const base = mkdtempSync(join(tmpdir(), "av-e2e-nested-"));
  const allowed = join(base, "allowed");
  mkdirSync(allowed);
  const requested = join(allowed, "new", "a", "b");
  const port = await freePort();
  const live = spawnLauncher([requested, String(port)], { ...process.env, TMPDIR: allowed });
  try {
    const ok = await live.waitForOk();
    assert.match(ok, new RegExp("dataDir=" + escapeRegExp(requested)));
    assert.equal(existsSync(join(requested, "vault.db")), true);
    assert.equal(live.child.exitCode, null);
    live.child.kill("SIGTERM");
    const exit = await waitExit(live.child);
    assert.equal(exit.code, 0);
  } finally {
    if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});

test("preflight rejects a dangling symlink ancestor", async () => {
  const base = mkdtempSync(join(tmpdir(), "av-e2e-dangling-"));
  const allowed = join(base, "allowed");
  mkdirSync(allowed);
  symlinkSync(join(base, "missing-target"), join(allowed, "dangling"), "dir");
  const requested = join(allowed, "dangling", "a");
  const held = await holdPort();
  try {
    const r = await runToExit([requested, String(held.port)], 20000, { ...process.env, TMPDIR: allowed });
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stdout, /FIXTURE_OK/);
    assert.match(r.stderr, /not resolvable/);
    assert.equal(existsSync(join(base, "missing-target")), false);
    assert.equal(existsSync(join(base, "missing-target", "a")), false);
  } finally {
    await held.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("shutdown handler is registered before FIXTURE_OK readiness output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "av-e2e-shutdown-"));
  const port = await freePort();
  const script = `
import { execSync } from "node:child_process";
import { run } from ${JSON.stringify(launcherPath)};
const dir = process.argv[1];
const port = Number(process.argv[2]);
let closed = 0;
const handle = {
  dataDir: dir,
  port,
  url: "http://127.0.0.1:" + port,
  repo: { connection: { prepare: () => ({ all: () => [{ seq: 0, name: "main", file: dir + "/vault.db" }] }) } },
  close: async () => { closed++; },
};
await run([dir, String(port)], {
  start: async () => handle,
  out: () => { execSync("kill -TERM " + process.pid); },
  wait: () => new Promise((resolve) => {
    const done = () => { process.off("SIGTERM", done); resolve(); };
    process.on("SIGTERM", done);
  }),
  exit: (code) => { process.exit(code); },
  err: (line) => { console.error(line); },
});
console.log("CLOSED:" + closed);
`;
  try {
    const r = await runNodeScript(script, [dir, String(port)]);
    assert.equal(r.code, 0);
    assert.equal(r.signal, null);
    assert.match(r.stdout, /CLOSED:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
