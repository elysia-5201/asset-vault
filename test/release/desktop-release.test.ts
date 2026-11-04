/**
 * 发布入口 scripts/desktop-release.ps1 的离线定向测试（RED→GREEN）。
 *
 * 边界：只跑 Plan 与 Windows TEMP 夹具；不访问 E:\ 生产树、不连 127.0.0.1:7317、
 * 不启停 App、不执行真实 manifest。Execute 分支只验证"拒绝路径"（缺确认 / 确认不符 /
 * 冻结被篡改），这些路径在创建日志目录与启动任何子进程之前就必须失败。
 *
 * 入口与 runtime 先复制到 Windows TEMP（WSL 的 /root 对 powershell.exe 不可见），
 * 这同时证明入口自包含：只依赖自身目录 + 显式传入的 manifest/payload/log。
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** WSL 路径 → Windows 路径（/mnt/c/x → C:\x）；原生 Windows 直接返回。 */
function winPath(p: string): string {
  if (process.platform === "win32") return p;
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (!m) throw new Error("not a /mnt/<drive>/ path: " + p);
  return m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\");
}

/** Windows 路径 → WSL 路径（C:\x → /mnt/c/x）；原生 Windows 直接返回。 */
function wslPath(p: string): string {
  if (process.platform === "win32") return p;
  const m = /^([a-zA-Z]):\\(.*)$/.exec(p);
  if (!m) throw new Error("not a drive path: " + p);
  return "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/");
}

function findPowerShell(): string {
  const candidates = [
    process.env.AV_POWERSHELL,
    "powershell.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  throw new Error("powershell.exe not found; set AV_POWERSHELL");
}

let ps = "";
let winTemp = "";
let staged: { root: string; entry: string; harness: string; guards: string; runtime: string };

/** 把入口 + runtime + harness 复制到 Windows TEMP，返回 WSL 路径。 */
function stageEntry(): typeof staged {
  const root = join(winTemp, "av-release-entry-" + Math.random().toString(16).slice(2, 10));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test", "release"), { recursive: true });
  cpSync(join(repoRoot, "scripts", "desktop-release.ps1"), join(root, "scripts", "desktop-release.ps1"));
  cpSync(join(repoRoot, "scripts", "desktop-release"), join(root, "scripts", "desktop-release"), { recursive: true });
  cpSync(join(repoRoot, "test", "release", "sequence-harness.ps1"), join(root, "test", "release", "sequence-harness.ps1"));
  cpSync(join(repoRoot, "test", "release", "entry-guards-harness.ps1"), join(root, "test", "release", "entry-guards-harness.ps1"));
  return {
    root,
    entry: join(root, "scripts", "desktop-release.ps1"),
    harness: join(root, "test", "release", "sequence-harness.ps1"),
    guards: join(root, "test", "release", "entry-guards-harness.ps1"),
    runtime: join(root, "scripts", "desktop-release", "runtime"),
  };
}

function runEntry(args: string[], opts: { timeout?: number } = {}) {
  return spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winPath(staged.entry), ...args], {
    encoding: "utf8",
    timeout: opts.timeout ?? 120000,
  });
}

interface Fixture {
  root: string;        // WSL path
  manifest: string;    // WSL path
  payload: string;     // WSL path
  logDir: string;      // WSL path
  releaseId: string;
}

function makeFixture(name: string, opts: { tempRoots?: boolean } = {}): Fixture {
  const root = join(winTemp, "av-release-test-" + name + "-" + Math.random().toString(16).slice(2, 10));
  // Execute-path tests must never point at a production root: tempRoots puts both roots under
  // this fixture's own fresh Windows TEMP directory.
  const appRoot = opts.tempRoots ? winPath(join(root, "app")) : "E:\\av-release-test\\app";
  const dataPrivate = opts.tempRoots ? winPath(join(root, ".av-apply-private")) : "E:\\av-release-test\\.av-apply-private";
  const payload = join(root, "payload");
  const files: Record<string, string> = {
    "apps/desktop/build/server.mjs": "// server fixture\nconsole.log('server');\n",
    "apps/desktop/build/build-info.json": '{"serverSha256":"fixture"}\n',
    "apps/web/dist/index.html": '<!doctype html><script src="/assets/index-TEST.js"></script>\n',
    "apps/web/dist/assets/index-TEST.js": "console.log('web fixture');\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const dst = join(payload, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, body);
  }
  const manifest = {
    schema: "av-exec-manifest/v1",
    appRoot,
    dataPrivate,
    payload: [
      { rel: "apps/desktop/build/server.mjs", bytes: Buffer.byteLength(files["apps/desktop/build/server.mjs"]), old: "1".repeat(64), new: sha256(files["apps/desktop/build/server.mjs"]), action: "replace" },
      { rel: "apps/desktop/build/build-info.json", bytes: Buffer.byteLength(files["apps/desktop/build/build-info.json"]), old: "2".repeat(64), new: sha256(files["apps/desktop/build/build-info.json"]), action: "replace" },
      { rel: "apps/web/dist/index.html", bytes: Buffer.byteLength(files["apps/web/dist/index.html"]), old: "3".repeat(64), new: sha256(files["apps/web/dist/index.html"]), action: "replace-LAST" },
      { rel: "apps/web/dist/assets/index-TEST.js", bytes: Buffer.byteLength(files["apps/web/dist/assets/index-TEST.js"]), old: null, new: sha256(files["apps/web/dist/assets/index-TEST.js"]), action: "add-new-exclusive" },
    ],
    baselineOld: { "apps/web/dist/assets/index-OLD.js": "4".repeat(64) },
    doNotWrite: [{ rel: "apps/desktop/build/schema.sql", sha256: "5".repeat(64) }],
    releaseId: "deadbeef",
    stamp: "20260101-000000",
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { root, manifest: manifestPath, payload, logDir: join(root, "logs"), releaseId: "deadbeef" };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

before(() => {
  ps = findPowerShell();
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", "[IO.Path]::GetTempPath()"], { encoding: "utf8" });
  assert.equal(r.status, 0, "GetTempPath failed: " + r.stderr);
  winTemp = wslPath(r.stdout.trim());
  mkdirSync(winTemp, { recursive: true });
  staged = stageEntry();
});

describe("Plan（默认模式：无生产访问 / 无文件写 / 无子进程）", () => {
  test("合法夹具 → exit 0，输出 6 步计划，不建日志目录、不启子进程、不泄漏输入路径", () => {
    const f = makeFixture("plan-ok");
    const before = listFiles(f.root);
    // 故意给一个不存在的 PowerShell：Plan 若尝试起子进程就会失败。
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-PowerShellPath", "Z:\\definitely-missing\\powershell.exe",
    ]);
    assert.equal(r.status, 0, "stderr=" + r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.execute, false);
    assert.deepEqual(plan.steps.map((s: any) => s.name), ["stage", "close", "backup", "archive", "apply", "start"]);
    assert.equal(plan.runtime.files, 13);
    assert.equal(plan.runtime.aggregate, "b07f072e843e015c934c8adaa37443be812297e2a5e502d566ae306549364782");
    assert.equal(plan.payloadSource.files, 4);
    assert.equal(plan.manifest.releaseId, "deadbeef");
    assert.equal(existsSync(f.logDir), false, "Plan 不得创建日志目录");
    assert.deepEqual(listFiles(f.root), before, "Plan 不得写任何文件");
    assert.equal(r.stdout.includes(winPath(f.payload)), false, "Plan 输出不得泄漏 payload 源绝对路径");
    assert.equal(r.stdout.includes(winPath(f.manifest)), false, "Plan 输出不得泄漏 manifest 绝对路径");
  });

  test("payload 字节与 manifest.new 不符 → 非 0，且不建日志目录", () => {
    const f = makeFixture("plan-badhash");
    writeFileSync(join(f.payload, "apps/desktop/build/server.mjs"), "// tampered\n");
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /payload/i);
    assert.equal(existsSync(f.logDir), false);
  });

  test("缺 -PayloadSource → 非 0（参数强制，不落默认值）", () => {
    const f = makeFixture("plan-missing");
    const r = runEntry(["-ManifestPath", winPath(f.manifest), "-LogDir", winPath(f.logDir)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /PayloadSource/i);
    assert.equal(existsSync(f.logDir), false);
  });

  test("payload 数量 ≠ 4 → 非 0（与 stage 的 4 文件不变量一致）", () => {
    const f = makeFixture("plan-5payload");
    const m = JSON.parse(readFileSync(f.manifest, "utf8"));
    const rel = "apps/desktop/build/extra.mjs";
    const body = "// extra fixture\n";
    const dst = join(f.payload, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, body);
    m.payload.push({ rel, bytes: Buffer.byteLength(body), old: "6".repeat(64), new: sha256(body), action: "replace" });
    writeFileSync(f.manifest, JSON.stringify(m, null, 2) + "\n");
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /payload/i);
    assert.equal(existsSync(f.logDir), false);
  });
});

describe("Execute 拒绝路径（确认 / 冻结门先于任何写与进程）", () => {
  test("缺 -ConfirmReleaseId → 非 0，不建日志目录", () => {
    const f = makeFixture("exec-noconfirm");
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ConfirmReleaseId/i);
    assert.equal(existsSync(f.logDir), false);
  });

  test("-ConfirmReleaseId 与 manifest.releaseId 不符 → 非 0，不建日志目录", () => {
    const f = makeFixture("exec-wrongconfirm");
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", "00000000",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ConfirmReleaseId/i);
    assert.equal(existsSync(f.logDir), false);
  });

  test("runtime 冻结被篡改 → 非 0（freeze 门），不建日志目录", () => {
    const f = makeFixture("exec-badfreeze");
    const bad = join(f.root, "runtime-bad");
    cpSync(staged.runtime, bad, { recursive: true });
    const target = join(bad, "apply.ps1");
    const buf = readFileSync(target);
    buf[0] = buf[0] === 0x23 ? 0x20 : 0x23; // '#' <-> ' '
    writeFileSync(target, buf);
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-RuntimeDir", winPath(bad),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /freeze|冻结|sha256/i);
    assert.equal(existsSync(f.logDir), false);
  });
});

describe("Execute 前置门（root 身份 / LogDir 隔离 / 精确确认）", () => {
  test("缺 -AppRoot/-DataPrivate → 非 0（不落默认根），不建日志目录", () => {
    const f = makeFixture("exec-noroots", { tempRoots: true });
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AppRoot/);
    assert.equal(existsSync(f.logDir), false);
  });

  test("-AppRoot 与 manifest 不符 → 非 0，且在任何写/进程之前", () => {
    const f = makeFixture("exec-rootmismatch", { tempRoots: true });
    const before = listFiles(f.root);
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
      "-AppRoot", winPath(join(f.root, "other-app")),
      "-DataPrivate", winPath(join(f.root, ".av-apply-private")),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /appRoot|root/i);
    assert.equal(existsSync(f.logDir), false);
    assert.deepEqual(listFiles(f.root), before, "root 不符不得写任何文件");
  });

  test("大写 -ConfirmReleaseId 被拒（-cne 精确比较）", () => {
    const f = makeFixture("exec-upperconfirm");
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", "DEADBEEF",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ConfirmReleaseId/);
    assert.equal(existsSync(f.logDir), false);
  });

  test("-LogDir 等于 AppRoot → 非 0，零写", () => {
    const f = makeFixture("exec-logdir-approot", { tempRoots: true });
    const before = listFiles(f.root);
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(join(f.root, "app")),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
      "-AppRoot", winPath(join(f.root, "app")),
      "-DataPrivate", winPath(join(f.root, ".av-apply-private")),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /LogDir|LOGDIR/i);
    assert.equal(existsSync(join(f.root, "app")), false);
    assert.deepEqual(listFiles(f.root), before);
  });

  test("-LogDir 已存在（空目录）→ 非 0，不覆盖不删除", () => {
    const f = makeFixture("exec-logdir-exists", { tempRoots: true });
    mkdirSync(f.logDir, { recursive: true });
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
      "-AppRoot", winPath(join(f.root, "app")),
      "-DataPrivate", winPath(join(f.root, ".av-apply-private")),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /LogDir|LOGDIR/i);
    assert.equal(existsSync(f.logDir), true);
    assert.deepEqual(listFiles(f.logDir), []);
  });

  test("合法 TEMP 根 + 全新 LogDir + fake 子进程 → 建日志、停在 stage、不写 app 根", () => {
    const f = makeFixture("exec-freshlog", { tempRoots: true });
    const r = runEntry([
      "-ManifestPath", winPath(f.manifest),
      "-PayloadSource", winPath(f.payload),
      "-LogDir", winPath(f.logDir),
      "-Execute", "-ConfirmReleaseId", f.releaseId,
      "-AppRoot", winPath(join(f.root, "app")),
      "-DataPrivate", winPath(join(f.root, ".av-apply-private")),
      // Fake child: a real executable that rejects these arguments with rc=2. It never runs
      // stage.ps1, so no release step executes; only the entry's own log/stop path is exercised.
      "-PowerShellPath", "C:\\Windows\\System32\\where.exe",
    ]);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(f.logDir), true, "fresh LogDir must be created");
    assert.equal(existsSync(join(f.logDir, "plan.json")), true);
    assert.equal(existsSync(join(f.logDir, "summary.json")), true);
    const summary = JSON.parse(readFileSync(join(f.logDir, "summary.json"), "utf8"));
    assert.equal(summary.mode, "execute");
    assert.equal(summary.ok, false);
    assert.equal(summary.stoppedAt, "stage");
    assert.equal(summary.steps.length, 1);
    assert.notEqual(summary.rc, 0);
    assert.equal(existsSync(join(f.root, "app")), false, "fake child must not run stage.ps1");
  });
});

describe("序列原语（离线 fake runner + 真实 -File 夹具）", () => {
  test("顺序/参数/失败即停/start 最多一次/exit 传播/AU-OK 闭包语义", () => {
    const work = join(winTemp, "av-release-seq-" + Math.random().toString(16).slice(2, 10));
    mkdirSync(work, { recursive: true });
    const r = spawnSync(ps, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winPath(staged.harness),
      "-CorePath", winPath(join(staged.root, "scripts", "desktop-release", "release-core.ps1")),
      "-WorkDir", winPath(work),
    ], { encoding: "utf8", timeout: 180000 });
    assert.equal(r.status, 0, "stdout=" + r.stdout + "\nstderr=" + r.stderr);
    // Pinned: the original 8 cases must all run; a harness that silently drops cases fails here.
    assert.match(r.stdout, /PASS n=8/);
    assert.match(r.stdout, /FAIL n=0/);
  });

  test("入口守卫夹具（LogDir 隔离 / argv 引号 / 逐步失败）", () => {
    const work = join(winTemp, "av-release-guards-" + Math.random().toString(16).slice(2, 10));
    mkdirSync(work, { recursive: true });
    const r = spawnSync(ps, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", winPath(staged.guards),
      "-CorePath", winPath(join(staged.root, "scripts", "desktop-release", "release-core.ps1")),
      "-WorkDir", winPath(work),
    ], { encoding: "utf8", timeout: 180000 });
    assert.equal(r.status, 0, "stdout=" + r.stdout + "\nstderr=" + r.stderr);
    assert.match(r.stdout, /PASS n=27/);
    assert.match(r.stdout, /FAIL n=0/);
  });
});
