/**
 * T1 纯核心：工程路径校验（真实自有 TMP，不碰真实 Unity/生产）。
 * 口径：realpath 归一允许 root 别名；Packages/ProjectSettings/manifest 自身符号链接一律拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "../../packages/core/src/pathnorm";
import {
  canonicalProjectPath, samePath, readManifest, parseUnityVersion, isSupportedUnityVersion,
} from "../../apps/server/src/services/unity-install-core";

const isProjectInvalid = (e: unknown): boolean =>
  (e as { details?: { code?: string } })?.details?.code === "UNITY_INSTALL_PROJECT_INVALID";
const directoryLink = process.platform === "win32" ? "junction" : "dir";

function makeProject(root: string, name = "My Project", version = "2021.3.22f1"): string {
  const project = join(root, name);
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(join(project, "Packages", "manifest.json"), '{\n  "dependencies": {}\n}\n');
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: " + version + "\n");
  return project;
}

test("canonicalProjectPath：真实 TMP 工程、空格、realpath 别名", () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-core-"));
  try {
    const project = makeProject(root);
    const ok = canonicalProjectPath(project);
    assert.equal(ok.name, "My Project");
    assert.equal(ok.unityVersion, "2021.3.22f1");
    assert.equal(ok.pathNorm, normalizePath(ok.path));
    assert.equal(ok.manifestPath, join(ok.path, "Packages", "manifest.json"));
    assert.equal(ok.projectVersionPath, join(ok.path, "ProjectSettings", "ProjectVersion.txt"));
    assert.equal(samePath("C:\\Work\\My Project", "c:\\work\\my project", "win32"), true);
    assert.equal(samePath("/Work/My Project", "/work/my project", "linux"), false);
    const link = join(root, "link-project");
    symlinkSync(project, link, directoryLink);
    try { assert.equal(canonicalProjectPath(link).path, ok.path); }
    finally { unlinkSync(link); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("版本解析与支持门：2020.3 不支持，2021.3+ 支持", () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-core-"));
  try {
    const bad = makeProject(root, "bad-project", "2020.3.48f1");
    assert.equal(isSupportedUnityVersion(parseUnityVersion(readFileSync(join(bad, "ProjectSettings", "ProjectVersion.txt"), "utf8"))), false);
    assert.equal(parseUnityVersion("m_EditorVersion: 2021.3.22f1\nm_EditorVersionWithRevision: 2021.3.22f1 (887be4894c44)\n"), "2021.3.22f1");
    assert.equal(parseUnityVersion("m_EditorVersion: 6000.0.23f1\n"), "6000.0.23f1");
    assert.equal(parseUnityVersion("no version here"), "");
    assert.equal(isSupportedUnityVersion("2021.3.22f1"), true);
    assert.equal(isSupportedUnityVersion("2022.1.0f1"), true);
    assert.equal(isSupportedUnityVersion("6000.0.23f1"), true);
    assert.equal(isSupportedUnityVersion("2021.2.19f1"), false);
    assert.equal(isSupportedUnityVersion(""), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("拒绝：相对路径、缺 manifest、Packages 目录链接", () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-core-"));
  try {
    assert.throws(() => canonicalProjectPath("relative/project"), isProjectInvalid);
    const noManifest = join(root, "no-manifest");
    mkdirSync(join(noManifest, "Packages"), { recursive: true });
    mkdirSync(join(noManifest, "ProjectSettings"), { recursive: true });
    writeFileSync(join(noManifest, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.22f1\n");
    assert.throws(() => canonicalProjectPath(noManifest), isProjectInvalid);

    const symPackages = makeProject(root, "sym-packages");
    const realPkgs = join(root, "real-packages");
    mkdirSync(realPkgs, { recursive: true });
    writeFileSync(join(realPkgs, "manifest.json"), '{"dependencies":{}}');
    const packages = join(symPackages, "Packages");
    rmSync(packages, { recursive: true, force: true });
    symlinkSync(realPkgs, packages, directoryLink);
    try { assert.throws(() => canonicalProjectPath(symPackages), isProjectInvalid); }
    finally { unlinkSync(packages); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("拒绝 manifest 文件符号链接", (context) => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-core-"));
  try {
    const project = makeProject(root);
    const manifest = join(project, "Packages", "manifest.json");
    const outside = join(root, "outside-manifest.json");
    writeFileSync(outside, '{"dependencies":{}}');
    rmSync(manifest);
    try {
      symlinkSync(outside, manifest, "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("当前 Windows 环境没有创建文件符号链接的权限");
        return;
      }
      throw error;
    }
    assert.throws(() => canonicalProjectPath(project), isProjectInvalid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readManifest：字节/文本/JSON/哈希一致", () => {
  const root = mkdtempSync(join(tmpdir(), "av-unity-core-"));
  try {
    const project = makeProject(root);
    const snap = readManifest(join(project, "Packages", "manifest.json"));
    assert.equal(snap.text, '{\n  "dependencies": {}\n}\n');
    assert.deepEqual(snap.json, { dependencies: {} });
    assert.equal(snap.hash, createHash("sha256").update(snap.bytes).digest("hex"));
    assert.equal(snap.bytes.length, Buffer.byteLength(snap.text));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
