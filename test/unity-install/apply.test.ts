/**
 * T2 应用：already_installed / replace 确认 / 备份 / 哈希 / 锁 / stale。
 * 真实自有 TMP 合成工程；不碰真实 Unity/生产。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreview, applyPreview, getOperation, cancelPreview, type UnityInstallDeps } from "../../apps/server/src/services/unity-install";
import { UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL } from "../../apps/server/src/services/unity-install-core";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function makeProject(root: string, opts: { version?: string; manifest?: string; lock?: string | null } = {}): string {
  const project = join(root, "Project");
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(join(project, "Packages", "manifest.json"), opts.manifest ?? '{\n  "dependencies": {}\n}\n');
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: " + (opts.version ?? "2021.3.22f1") + "\n");
  if (opts.lock !== null) writeFileSync(join(project, "Packages", "packages-lock.json"), opts.lock ?? '{\n  "dependencies": {}\n}\n');
  return project;
}

function deps(dataDir: string, overrides: Partial<UnityInstallDeps> = {}): UnityInstallDeps {
  return { dataDir, repo: { getSetting: () => null }, now: () => NOW, execFile: async () => ({ stdout: "ok" }), ...overrides };
}

const opsCount = (dataDir: string): number => {
  const dir = join(dataDir, "unity-install", "operations");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).length : 0;
};

test("apply：同包同 URL -> already_installed，零 manifest 写、零 operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "' + UNITY_MCP_PACKAGE_URL + '"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    assert.equal(result.status, "already_installed");
    assert.equal(result.operationId, null);
    assert.equal(result.backupDir, null);
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.equal(opsCount(dataDir), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：replace 未 confirmReplace -> 409，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_REPLACE_NOT_CONFIRMED");
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.equal(opsCount(dataDir), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：replace 确认 -> config_applied、备份原字节、lock 不变、plannedAfterHash 持久、二次 stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const lockPath = join(project, "Packages", "packages-lock.json");
    const before = readFileSync(manifestPath);
    const lockBefore = readFileSync(lockPath);
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true, confirmReplace: true });
    assert.equal(result.status, "config_applied");
    assert.ok(result.operationId);
    assert.ok(result.backupDir);
    const after = readFileSync(manifestPath);
    assert.equal(after.equals(before), false);
    assert.equal(readFileSync(join(result.backupDir!, "manifest.json")).equals(before), true);
    assert.equal(readFileSync(lockPath).equals(lockBefore), true);
    const op = getOperation(deps(dataDir), result.operationId!);
    assert.equal(op.status, "config_applied");
    assert.equal(op.beforeHash, sha(before));
    assert.equal(op.afterHash, sha(after));
    assert.equal(op.plannedAfterHash, op.afterHash);
    const meta = JSON.parse(readFileSync(join(result.backupDir!, "meta.json"), "utf8"));
    assert.equal(meta.afterHash, op.afterHash);
    assert.ok(meta.files.some((f: any) => f.name === "manifest.json" && f.sha256 === sha(before)));
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true, confirmReplace: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
    assert.equal(readFileSync(manifestPath).equals(after), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：add -> config_applied、manifest 含目标依赖、备份原字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    assert.equal(result.status, "config_applied");
    const afterText = readFileSync(manifestPath, "utf8");
    assert.ok(afterText.includes(UNITY_MCP_PACKAGE_ID));
    assert.ok(afterText.includes(UNITY_MCP_PACKAGE_URL));
    assert.equal(readFileSync(join(result.backupDir!, "manifest.json")).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：conflict preview -> 409 CONFLICT，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const manifest = '{\n  "dependencies": {\n    "' + UNITY_MCP_PACKAGE_ID + '": "file:../local"\n  }\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_CONFLICT");
    assert.equal(readFileSync(manifestPath).equals(before), true);
    assert.equal(opsCount(dataDir), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：过期 preview -> 409 PREVIEW_EXPIRED，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const later = deps(dataDir, { now: () => new Date("2026-11-05T12:11:00.000Z") });
    await assert.rejects(() => applyPreview(later, { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_EXPIRED");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：previewHash 被篡改 -> 409 PREVIEW_STALE，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const file = join(dataDir, "unity-install", "previews", preview.previewId + ".json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.previewHash = "0".repeat(64);
    writeFileSync(file, JSON.stringify(raw));
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：preview 后 manifest 被外改 -> 409 PREVIEW_STALE，零写", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const preview = await createPreview(deps(dataDir), project);
    const changed = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
    writeFileSync(manifestPath, changed);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true }), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
    assert.equal(readFileSync(manifestPath, "utf8"), changed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：同工程并发第二 apply -> 409 LOCKED", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const preview = await createPreview(deps(dataDir), project);
    const p1 = applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    const p2 = applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    const results = await Promise.allSettled([p1, p2]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected, "必须有一个 apply 被锁拒绝");
    assert.equal(rejected.reason.details?.code, "UNITY_INSTALL_LOCKED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：confirm 非 true -> 400 INVALID_INPUT；preview 不存在 -> 404；非法 id -> 400", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const preview = await createPreview(deps(dataDir), project);
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: false as any }), (e: any) =>
      e.code === "INVALID_INPUT" && e.details?.code === "UNITY_INSTALL_CONFLICT");
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: "00000000-0000-4000-8000-000000000000", confirm: true }), (e: any) =>
      e.code === "NOT_FOUND" && e.details?.code === "UNITY_INSTALL_NOT_FOUND");
    await assert.rejects(() => applyPreview(deps(dataDir), { previewId: "../x", confirm: true }), (e: any) =>
      e.code === "INVALID_INPUT" && e.details?.code === "UNITY_INSTALL_INVALID_ID");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：BOM add -> config_applied，BOM/缩进/非目标键保留，备份原字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-bom-"));
  try {
    const dataDir = join(root, "data");
    const manifest = "\uFEFF" + '{\n    "dependencies": {},\n    "scopedRegistries": []\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const lockPath = join(project, "Packages", "packages-lock.json");
    const before = readFileSync(manifestPath);
    const lockBefore = readFileSync(lockPath);
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    assert.equal(result.status, "config_applied");
    const afterText = readFileSync(manifestPath, "utf8");
    assert.equal(afterText.startsWith("\uFEFF"), true, "BOM 必须保留");
    assert.ok(afterText.includes('\n    "dependencies"'), "4 空格缩进必须保留");
    assert.ok(afterText.includes('"scopedRegistries"'), "非目标键必须保留");
    assert.ok(afterText.includes(UNITY_MCP_PACKAGE_ID));
    assert.ok(afterText.includes(UNITY_MCP_PACKAGE_URL));
    assert.equal(readFileSync(join(result.backupDir!, "manifest.json")).equals(before), true);
    assert.equal(readFileSync(lockPath).equals(lockBefore), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("apply：BOM replace -> config_applied，BOM/缩进/非目标键保留，备份原字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-bom-"));
  try {
    const dataDir = join(root, "data");
    const manifest = "\uFEFF" + '{\n    "dependencies": {\n        "' + UNITY_MCP_PACKAGE_ID + '": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0"\n    },\n    "keep": true\n}\n';
    const project = makeProject(root, { manifest });
    const manifestPath = join(project, "Packages", "manifest.json");
    const lockPath = join(project, "Packages", "packages-lock.json");
    const before = readFileSync(manifestPath);
    const lockBefore = readFileSync(lockPath);
    const preview = await createPreview(deps(dataDir), project);
    const result = await applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true, confirmReplace: true });
    assert.equal(result.status, "config_applied");
    const afterText = readFileSync(manifestPath, "utf8");
    assert.equal(afterText.startsWith("\uFEFF"), true, "BOM 必须保留");
    assert.ok(afterText.includes('\n    "dependencies"'), "4 空格缩进必须保留");
    assert.ok(afterText.includes('"keep": true'), "非目标键必须保留");
    assert.ok(afterText.includes(UNITY_MCP_PACKAGE_URL));
    assert.equal(readFileSync(join(result.backupDir!, "manifest.json")).equals(before), true);
    assert.equal(readFileSync(lockPath).equals(lockBefore), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel：apply 已取锁窗口 -> 409 LOCKED，pending 成功，锁释放后独立 preview 可取消", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-apply-lock-"));
  try {
    const dataDir = join(root, "data");
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const preview = await createPreview(deps(dataDir), project);
    const pending = applyPreview(deps(dataDir), { previewId: preview.previewId, confirm: true });
    let cancelErr: any;
    try { cancelPreview(deps(dataDir), preview.previewId); } catch (e) { cancelErr = e; }
    const [settled] = await Promise.allSettled([pending]);
    assert.equal(settled.status, "fulfilled", "pending apply 必须成功");
    const result = (settled as PromiseFulfilledResult<any>).value;
    assert.ok(cancelErr, "cancel 必须被锁拒绝");
    assert.equal(cancelErr.code, "CONFLICT");
    assert.equal(cancelErr.details?.code, "UNITY_INSTALL_LOCKED");
    assert.equal(result.status, "config_applied");
    assert.ok(result.operationId);
    const after = readFileSync(manifestPath);
    assert.equal(after.equals(before), false);
    const op = getOperation(deps(dataDir), result.operationId!);
    assert.equal(op.status, "config_applied");
    const stored = JSON.parse(readFileSync(join(dataDir, "unity-install", "previews", preview.previewId + ".json"), "utf8"));
    assert.equal(stored.used, true);
    assert.throws(() => cancelPreview(deps(dataDir), preview.previewId), (e: any) =>
      e.code === "CONFLICT" && e.details?.code === "UNITY_INSTALL_PREVIEW_STALE");
    const independent = await createPreview(deps(dataDir), project);
    assert.deepEqual(cancelPreview(deps(dataDir), independent.previewId), { cancelled: true });
    assert.equal(existsSync(join(dataDir, "unity-install", "previews", independent.previewId + ".json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
