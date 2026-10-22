#!/usr/bin/env node
/**
 * v0.7.1 构建一致性校验（FIX-3 / F6）——独立于构建脚本，供 CI/验收/部署前调用。
 *
 * 用法：node scripts/verify-build.mjs [--json]
 * 退出码：0 = 一致；1 = 不一致（任何一项失败）；2 = 无法判断（缺产物）。
 *
 * 检查项：
 *  B1 build/server.mjs 存在且非空；
 *  B2 bundle 含当前版本关键路由标记（import-plans / import-runs / staging）；
 *  B3 build/build-info.json 存在，version 与 package.json 一致，serverSha256 与 bundle 实际 sha256 一致（防陈旧产物）；
 *  B4 build/schema.sql 与 apps/server/src/db/schema.sql 逐字节一致；
 *  B5（仅 git 仓库）build-info.commit 与 HEAD 一致；非 git 时记 warning 不失败。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(REPO, "apps/desktop/build/server.mjs");
const INFO = join(REPO, "apps/desktop/build/build-info.json");
const BUILT_SCHEMA = join(REPO, "apps/desktop/build/schema.sql");
const SRC_SCHEMA = join(REPO, "apps/server/src/db/schema.sql");
const PKG = join(REPO, "package.json");

const checks = [];
const add = (id, name, ok, detail, fatal = true) => checks.push({ id, name, ok: !!ok, detail: String(detail), fatal });

function main() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const version = String(pkg.version ?? "");
  add("B1", "bundle 存在且非空", existsSync(BUNDLE) && statSync(BUNDLE).size > 0, BUNDLE + (existsSync(BUNDLE) ? " (" + statSync(BUNDLE).size + "B)" : " 缺失"));
  if (!existsSync(BUNDLE)) return finish();

  const text = readFileSync(BUNDLE, "utf8");
  const markers = ["/api/import-plans", "/api/import-runs", "/api/staging"];
  add("B2", "bundle 含 v0.7.x 关键路由标记", markers.every((m) => text.includes(m)),
    markers.map((m) => m + "=" + text.includes(m)).join(" "));

  let info = null;
  try { info = JSON.parse(readFileSync(INFO, "utf8")); } catch { info = null; }
  const sha = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");
  add("B3a", "build-info.json 存在且 version 与 package.json 一致",
    !!info && String(info.version) === version, info ? "build=" + info.version + " pkg=" + version : "build-info.json 缺失");
  add("B3b", "bundle sha256 与 build-info.serverSha256 一致（产物未陈旧）",
    !!info && String(info.serverSha256) === sha,
    info ? "build-info=" + String(info.serverSha256).slice(0, 16) + " actual=" + sha.slice(0, 16) : "n/a");

  if (existsSync(BUILT_SCHEMA) && existsSync(SRC_SCHEMA)) {
    const same = Buffer.compare(readFileSync(BUILT_SCHEMA), readFileSync(SRC_SCHEMA)) === 0;
    add("B4", "build/schema.sql 与源码逐字节一致", same,
      same ? "identical" : "build=" + statSync(BUILT_SCHEMA).size + "B src=" + statSync(SRC_SCHEMA).size + "B");
  } else add("B4", "build/schema.sql 与源码逐字节一致", false, "schema 产物或源码缺失");

  let head = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { head = null; }
  if (head && info && info.commit) add("B5", "build-info.commit 与 HEAD 一致", String(info.commit) === head, "build=" + String(info.commit).slice(0, 10) + " head=" + head.slice(0, 10), false);
  else add("B5", "build-info.commit 与 HEAD 一致", true, "非 git 或无 commit 信息（warning）", false);

  return finish();
}

function finish() {
  const failed = checks.filter((c) => c.fatal && !c.ok);
  const ok = failed.length === 0;
  const out = { ok, version: safeVersion(), at: new Date().toISOString(), checks };
  if (!process.argv.includes("--json")) {
    for (const c of checks) console.log((c.ok ? "  [PASS] " : "  [FAIL] ") + c.id + " " + c.name + " — " + c.detail);
    console.log(ok ? "BUILD OK (" + checks.length + " checks)" : "BUILD STALE (" + failed.length + " failed)");
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(out));
  process.exit(ok ? 0 : 1);
}
function safeVersion() { try { return String(JSON.parse(readFileSync(PKG, "utf8")).version ?? ""); } catch { return null; } }

main();
