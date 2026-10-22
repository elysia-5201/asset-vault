#!/usr/bin/env node
/**
 * v0.7.1 独立验收（task-55 补位；独立于实现者）
 *
 * 用法：
 *   node --import tsx scripts/acceptance-v071.mjs            # 临时库/临时 staging，跑完清理
 *   node --import tsx scripts/acceptance-v071.mjs --strict   # SKIP 也视为失败（e2e 阶段）
 *   node --import tsx scripts/acceptance-v071.mjs --keep     # 保留临时目录便于取证
 *
 * 覆盖：风险扫描（.cs/.dll/Editor/大小写/伪装/损坏/超限）、unknown 不重试、
 *       staging 台账/dry-run/越界/活跃保护、构建一致性、run_item 终态。
 * 原则：能力探测——接口未就绪的条目 SKIP 并写明期望契约，绝不伪造成 PASS。
 * 约束：只用 os.tmpdir() 下的临时 SQLite 与临时 staging；**不触碰生产 data**。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openTempDb, addAsset, addAvatar, addItem, addRoot } from "../test/schema/_db";
import { Repo } from "../apps/server/src/db/repo";
import { sha256File } from "../packages/core/src/hash.ts";
import { listArchive } from "../packages/core/src/archive/list.ts";
import { listUnityPackage } from "../packages/core/src/unitypackage.ts";
import * as structure from "../apps/server/src/services/structure";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const KEEP = argv.includes("--keep");

const rows = [];
function record(id, area, desc, status, detail = "") {
  rows.push({ id, area, desc, status, detail: String(detail) });
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : status === "BLOCKED" ? "BLOCKED" : "SKIP";
  console.log("  [" + mark + "] " + id + " " + desc + (detail ? " — " + String(detail).slice(0, 300) : ""));
}
const pass = (id, area, desc, detail) => record(id, area, desc, "PASS", detail);
const fail = (id, area, desc, detail) => record(id, area, desc, "FAIL", detail);
const skip = (id, area, desc, detail) => record(id, area, desc, "SKIP", detail);
/** BLOCKED：无法在本环境自动化（如真实 Unity 导入）——strict 不计入失败，报告里显式记录 UNVERIFIED。 */
const blocked = (id, area, desc, detail) => record(id, area, desc, "BLOCKED", detail);
const check = (id, area, desc, ok, detail) => (ok ? pass : fail)(id, area, desc, detail);
const errCode = (e) => String((e && (e.code || e.name)) || e);

const TMP = mkdtempSync(join(tmpdir(), "av-v071-"));
const FIX = join(TMP, "fixtures");
const WORK = join(TMP, "work");
const STAGING = join(TMP, "unity-staging");
const PROJECT = join(WORK, "UnityProject");
mkdirSync(WORK, { recursive: true });
mkdirSync(join(PROJECT, "Assets"), { recursive: true });
mkdirSync(FIX, { recursive: true });
mkdirSync(STAGING, { recursive: true });

// ---------------------------------------------------------------- 夹具（真实 tar.gz / zip，Python 生成）
const PY = String.raw`
import io, os, sys, tarfile, hashlib, zipfile

out = sys.argv[1]

def guid(path):
    return hashlib.md5(path.encode("utf-8")).hexdigest()

def asset_bytes(path):
    low = path.lower()
    if low.endswith(".cs"): return b"using UnityEditor;\npublic class Evil : EditorWindow {}\n"
    if low.endswith(".dll"): return b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 64
    if low.endswith(".so") or low.endswith(".dylib"): return b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 64
    if low.endswith(".asmdef"): return b'{"name": "Evil", "references": []}'
    if low.endswith(".pdf"): return b"PK\x03\x04" + b"\x00" * 32          # 伪装：pdf 里是 zip 魔数
    if low.endswith(".png"): return b"MZ\x90\x00" + b"\x00" * 16          # 伪装：png 里是 PE 魔数
    if low.endswith(".exe"): return b"MZ\x90\x00" + b"\x00" * 32
    return path.encode("utf-8") + b" fixture content"

def upkg(paths, preview=False):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT) as tar:
        for path in paths:
            g = guid(path)
            def add(name, data):
                ti = tarfile.TarInfo(g + "/" + name)
                ti.size = len(data); ti.mtime = 0; ti.mode = 0o644
                tar.addfile(ti, io.BytesIO(data))
            add("pathname", path.encode("utf-8"))
            add("asset", asset_bytes(path))
            add("asset.meta", ("fileFormatVersion: 2\nguid: " + g + "\npathname: " + path + "\n").encode("utf-8"))
            if preview: add("preview.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    return buf.getvalue()

def write(name, data):
    p = os.path.join(out, name)
    with open(p, "wb") as f: f.write(data)
    print(p)

write("ok_single.unitypackage", upkg(["Assets/Manuka/Manuka_body.fbx"]))
write("risky.unitypackage", upkg([
    "Assets/Editor/EvilEditor.cs",
    "Assets/Scripts/Evil.cs",
    "Assets/Plugins/Native.dll",
    "Assets/Data/Evil.asmdef",
    "Assets/Textures/normal.png",
]))
write("casing.unitypackage", upkg([
    "ASSETS\\EDITOR\\Bad.CS",
    "assets/plugins/lib.DLL",
]))
write("disguised.unitypackage", upkg([
    "Assets/readme.pdf",
    "Assets/pic.png",
]))
def zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
    return buf.getvalue()

# 计划级 magic：真实文件（扩展名 .pdf，内容其实是 zip，内含 upkg）→ computePlanRisk 的 magicReader 应读到 PK
write("disguised_container.pdf", zip_bytes([("Manuka/manuka.unitypackage", upkg(["Assets/Manuka/Manuka_body.fbx"]))]))
write("corrupt.unitypackage", b"this is not a gzip and not a tar")
`;

function buildFixtures() {
  const r = spawnSync("python3", ["-c", PY, FIX], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("fixture generation failed: " + (r.stderr || r.stdout));
  const names = ["ok_single.unitypackage", "risky.unitypackage", "casing.unitypackage", "disguised.unitypackage", "corrupt.unitypackage", "disguised_container.pdf"];
  const missing = names.filter((n) => !existsSync(join(FIX, n)));
  if (missing.length) throw new Error("fixture files missing: " + missing.join(", "));
  const out = {};
  for (const name of names) out[name.replace(/\.(unitypackage|pdf)$/, "")] = join(FIX, name);
  return out;
}

// ---------------------------------------------------------------- 环境种子（临时库 + 真解析）
async function seedEnv(specs) {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "v071-" + Math.random().toString(36).slice(2) });
  addAvatar(t.db, "Manuka");
  const assets = {};
  for (const spec of specs) {
    const st = statSync(spec.path);
    const a = addAsset(t.db, itemId, rootId, spec.path, {
      kind: spec.kind, container: spec.container, path: spec.path,
      size: st.size, mtime: new Date(st.mtimeMs).toISOString(), sha256: await sha256File(spec.path),
    });
    let parseFailed = false;
    if (spec.container === "unitypackage") {
      try {
        const U = await listUnityPackage(spec.path);
        repo.replaceUnityPackageAssets(a, U.assets.map((x) => ({ guid: x.guid, assetPath: x.assetPath, type: x.type, size: x.size, hasPreview: x.hasPreview })));
      } catch { parseFailed = true; }   // 损坏包：不中断种子，按 failed 资产交给结构分析
    } else {
      const L = await listArchive(spec.path);
      for (const e of L.entries) t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,?,?)")
        .run(a, e.path, e.size, e.isDir ? 1 : 0, e.path.includes(".") ? "." + e.path.split(".").pop().toLowerCase() : null);
    }
    t.db.prepare("UPDATE assets SET index_state=? WHERE id=?").run(parseFailed ? "failed" : "done", a);
    assets[spec.key] = a;
  }
  await structure.analyzeItemStructure(repo, itemId);
  return { t, repo, itemId, rootId, assets, units: repo.listUnits({ itemId }) };
}

function importableUnit(env, hint) {
  const list = env.units.filter((u) => Number(u.importable) === 1);
  if (!hint) return list[0] ?? null;
  return list.find((u) => String(u.name || "").toLowerCase().includes(hint) || String(u.rel_path || "").toLowerCase().includes(hint)) ?? list[0] ?? null;
}

/** mock Unity：健康（read_console 恒成功、无 error）；ImportPackage 返回 1 条 QUEUED。 */
function mockUnity() {
  const calls = { csharp: 0, importSent: 0, call: 0 };
  return {
    calls,
    unity: {
      endpoint: "mock", serverName: "mock",
      async csharp(code) {
        calls.csharp++;
        const c = String(code);
        // unityEditorInfo(): 需要 dataPath|projectPath|version|playing|compiling|scene
        if (c.includes("Application.dataPath")) return join(PROJECT, "Assets") + "|" + PROJECT + "|2022.3.22f1|0|0|";
        if (c.includes("ImportPackage")) { calls.importSent++; return "QUEUED|" + STAGING + "|1"; }
        return "";
      },
      async call() { calls.call++; return { isError: false, text: "", structured: { data: [] } }; },
    },
  };
}

function riskState(planView) { return planView && planView.plan ? planView.plan.risk_state ?? null : null; }
function riskText(planView) { return JSON.stringify(planView && planView.plan ? planView.plan.risk_json ?? "" : "").toLowerCase(); }
function tryPlan(repo, unitId) {
  try { return { view: structure.createImportPlan(repo, { unitIds: [Number(unitId)], projectPath: PROJECT }), error: null }; }
  catch (e) { return { view: null, error: e }; }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log("v0.7.1 acceptance | tmp=" + TMP + " | strict=" + STRICT);
  const fixtures = buildFixtures();

  // ---- S：schema v9 / 迁移 / 台账唯一 ----
  try {
    const t = openTempDb();
    const cols = (table) => t.db.prepare("PRAGMA table_info(" + table + ")").all().map((r) => String(r.name));
    const planCols = cols("import_plans"), runCols = cols("import_runs");
    const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    check("S1", "SCHEMA", "v9：import_plans.risk_json/risk_state + import_runs.verification_scope/checked_count/expected_count 存在",
      planCols.includes("risk_json") && planCols.includes("risk_state") && runCols.includes("verification_scope") && runCols.includes("checked_count") && runCols.includes("expected_count"),
      "plan=" + planCols.filter((c) => c.startsWith("risk")).join(",") + " run=" + runCols.filter((c) => /verification|checked|expected/.test(c)).join(","));
    check("S2", "SCHEMA", "staging_files 台账表存在（v9）", tables.includes("staging_files"), "tables=" + tables.filter((x) => x.startsWith("staging")).join(","));
    const mig = await import("../apps/server/src/db/migrate.ts");
    mig.migrate(t.db);
    const ver1 = (t.db.prepare("SELECT value v FROM schema_meta WHERE key='version'").get() || {}).v;
    mig.migrate(t.db);
    const ver2 = (t.db.prepare("SELECT value v FROM schema_meta WHERE key='version'").get() || {}).v;
    check("S3", "SCHEMA", "migrate 幂等（连续两次执行版本一致）", ver1 === ver2 && String(ver1) === String(mig.SCHEMA_VERSION), "version=" + ver1 + "→" + ver2 + " (SCHEMA_VERSION=" + mig.SCHEMA_VERSION + ")");
    t.close();
  } catch (e) { fail("S1", "SCHEMA", "schema 检查异常", String(e && e.stack || e)); }

  // ---- R：风险扫描（FIX-1；core scanPaths magic + structure.computePlanRisk/applyPlanRisk） ----
  try {
    const env = await seedEnv([{ key: "risky", path: fixtures.risky, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "risky");
      check("R0a", "RISK", "风险夹具解析出可导入单元（前置）", !!u, env.units.map((x) => x.name + ":" + x.policy + ":imp=" + x.importable).join(" | "));
      if (!u) throw new Error("no importable unit for risky fixture");
      const view0 = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT });
      const applied = typeof structure.applyPlanRisk === "function" ? await structure.applyPlanRisk(env.repo, view0.plan.id) : null;
      const view = applied ?? view0;
      const risks = view.risks;
      check("R0b", "RISK", "applyPlanRisk 落库 risks（scannerVersion/digest/hits/state）",
        !!risks && Number(risks.scannerVersion) >= 2 && typeof risks.digest === "string" && Array.isArray(risks.hits),
        risks ? JSON.stringify({ v: risks.scannerVersion, digest: String(risks.digest).slice(0, 12), state: risks.state, hits: risks.hits.length }) : "applyPlanRisk 缺失或无 risks");
      if (!risks) {
        for (const id of ["R1", "R2", "R3", "R4"]) skip(id, "RISK", "风险判定（" + id + "）", "接口未就绪：期望 structure.applyPlanRisk + packages/core/src/risk.ts scanPaths");
      } else {
        const types = new Set(risks.hits.map((h) => String(h.type)));
        check("R1", "RISK", ".cs → hits 含 code/editor_code；计划进入 needs_confirmation（或 blocked）",
          (types.has("code") || types.has("editor_code")) && ["needs_confirmation", "blocked"].includes(String(view.plan.status)) && ["warning", "blocked"].includes(String(risks.state)),
          "types=" + [...types].join(",") + " state=" + risks.state + " status=" + view.plan.status);
        check("R2", "RISK", ".dll → hits 含 assembly", types.has("assembly"), "types=" + [...types].join(","));
        check("R3", "RISK", "Editor/ 下 .cs → 单独归为 editor_code", types.has("editor_code"), "types=" + [...types].join(","));
        const asm = risks.hits.find((h) => String(h.type) === "asmdef");
        check("R4", "RISK", ".asmdef → hits 含 asmdef 且 severity=info", !!asm && String(asm.severity) === "info", asm ? JSON.stringify(asm) : "none");
      }
    } finally { env.t.close(); }
  } catch (e) { fail("R0a", "RISK", "风险夹具流程异常", String(e && e.stack || e)); }

  // R5 大小写/反斜杠
  try {
    const env = await seedEnv([{ key: "casing", path: fixtures.casing, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "casing");
      if (!u) fail("R5", "RISK", "大小写夹具无可导入单元", env.units.map((x) => x.name + ":" + x.importable).join(" | "));
      else if (typeof structure.applyPlanRisk !== "function") skip("R5", "RISK", "大小写/反斜杠（ASSETS\\\\EDITOR\\\\Bad.CS、.DLL）必须识别", "接口未就绪（同 R0b）");
      else {
        const v0 = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT });
        const v = (await structure.applyPlanRisk(env.repo, v0.plan.id)) ?? v0;
        const types = new Set((v.risks && v.risks.hits ? v.risks.hits : []).map((h) => String(h.type)));
        check("R5", "RISK", "大小写/反斜杠（ASSETS\\\\EDITOR\\\\Bad.CS、.DLL）→ editor_code + assembly",
          types.has("editor_code") && types.has("assembly"), "types=" + [...types].join(","));
      }
    } finally { env.t.close(); }
  } catch (e) { fail("R5", "RISK", "大小写夹具流程异常", String(e && e.stack || e)); }

  // R6a：core magic 能力（scanPaths 的 magic 读取器，≤8B latin1）——正例 + 反例
  try {
    const risk = await import("../packages/core/src/risk.ts");
    const scan = (paths, magicMap) => risk.scanPaths(paths, { magic: (p) => (p in magicMap ? magicMap[p] : null) });
    const pdfPk = scan(["Assets/readme.pdf"], { "Assets/readme.pdf": "PK\u0003\u0004" });
    const pngMz = scan(["Assets/pic.png"], { "Assets/pic.png": "MZ\u0090\u0000" });
    const zipPk = scan(["Assets/pack.zip"], { "Assets/pack.zip": "PK\u0003\u0004" });
    const realPdf = scan(["Assets/real.pdf"], { "Assets/real.pdf": "%PDF-1.7" });
    check("R6a", "RISK", "scanPaths+magic：pdf→PK / png→MZ 判 disguised；zip→PK、pdf→%PDF 不误报",
      pdfPk.hits.some((h) => h.type === "disguised") && pngMz.hits.some((h) => h.type === "disguised")
        && !zipPk.hits.some((h) => h.type === "disguised") && !realPdf.hits.some((h) => h.type === "disguised"),
      "pdf=" + JSON.stringify(pdfPk.hits.map((h) => h.type)) + " png=" + JSON.stringify(pngMz.hits.map((h) => h.type))
        + " zip=" + JSON.stringify(zipPk.hits.map((h) => h.type)) + " realPdf=" + JSON.stringify(realPdf.hits.map((h) => h.type)));
  } catch (e) { fail("R6a", "RISK", "core magic 能力异常", String(e && e.stack || e)); }

  // R6b：计划级（computePlanRisk 的 magicReader 读真实文件前 8B；不依赖 importable，直接建 plan_item）
  try {
    const fx = fixtures.disguised_container;
    if (!fx || !existsSync(fx)) fail("R6b", "RISK", "计划级 magic（真实 .pdf 实为 zip）", "夹具缺失: " + String(fx));
    else {
      const env = await seedEnv([{ key: "dc", path: fx, container: "zip", kind: "archive" }]);
      try {
        const anyUnit = env.units[0];
        if (!anyUnit) fail("R6b", "RISK", "计划级 magic（真实 .pdf 实为 zip）", "夹具未解析出任何 unit");
        else {
          const plan = env.repo.createImportPlan({ itemId: env.itemId, projectPath: PROJECT, status: "ready", precheck: {} });
          env.repo.addImportPlanItem({
            planId: plan.id, unitId: Number(anyUnit.id), assetId: Number(anyUnit.asset_id),
            path: fx, policy: String(anyUnit.policy), fingerprint: anyUnit.fingerprint ?? null,
          });
          const risks = await structure.computePlanRisk(env.repo, plan.id);
          const hits = risks.hits || [];
          check("R6b", "RISK", "computePlanRisk 接 magic：真实 .pdf（内容 zip）→ disguised",
            hits.some((h) => String(h.type) === "disguised"),
            "state=" + risks.state + " types=" + JSON.stringify(hits.map((h) => h.type)) + " path=" + fx);
        }
      } finally { env.t.close(); }
    }
  } catch (e) { fail("R6b", "RISK", "计划级 magic 流程异常", String(e && e.stack || e)); }

  // R7/R8 损坏包 → unknown（不可导入，不伪造 ok）
  try {
    const env = await seedEnv([{ key: "corrupt", path: fixtures.corrupt, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const importables = env.units.filter((u) => Number(u.importable) === 1);
      const limited = env.units.filter((u) => ["limited", "failed"].includes(String(u.parse_state)) || String(u.policy) === "unknown_structure");
      check("R7", "RISK", "损坏包 → 无可导入单元（unknown/limited，不伪造成功）", importables.length === 0 && limited.length >= 1,
        env.units.map((u) => u.policy + ":" + u.parse_state + ":imp=" + u.importable).join(" | "));
      if (limited[0]) {
        const r = tryPlan(env.repo, limited[0].id);
        check("R8", "RISK", "unknown/limited 单元建计划被拒（INVALID_INPUT）", errCode(r.error) === "INVALID_INPUT", "code=" + errCode(r.error));
      } else skip("R8", "RISK", "unknown 单元建计划门禁", "没有 limited 单元可测");
    } finally { env.t.close(); }
  } catch (e) { fail("R7", "RISK", "损坏包流程异常", String(e && e.stack || e)); }

  // R9/R10 风险门禁与显式 ack（task-51 语义）
  try {
    const t = openTempDb(); const repo = new Repo(t.db);
    const itemId = addItem(t.db, { title: "risk-gate" });
    const blockedPlan = repo.createImportPlan({ itemId, projectPath: PROJECT, status: "blocked", precheck: {} });
    repo.updateImportPlan(blockedPlan.id, { risk_state: "blocked" });
    let code = null;
    try { structure.confirmImportPlan(repo, blockedPlan.id); } catch (e) { code = errCode(e); }
    check("R9", "RISK", "blocked 风险计划 confirm → RISK_BLOCKED（即使 ack 也不放行）", code === "RISK_BLOCKED", "code=" + code);
    let codeAck = null;
    try { structure.confirmImportPlan(repo, blockedPlan.id, { riskAck: true }); } catch (e) { codeAck = errCode(e); }
    check("R9b", "RISK", "blocked + riskAck=true 仍 → RISK_BLOCKED（风险阻断不可确认）", codeAck === "RISK_BLOCKED", "code=" + codeAck);

    const warnPlan = repo.createImportPlan({ itemId, projectPath: PROJECT, status: "needs_confirmation", precheck: {} });
    repo.updateImportPlan(warnPlan.id, { risk_state: "warning", risk_json: JSON.stringify({ scannerVersion: 2, digest: "digest-x", state: "warning", hits: [] }) });
    let code2 = null;
    try { structure.confirmImportPlan(repo, warnPlan.id); } catch (e) { code2 = errCode(e); }
    check("R10a", "RISK", "warning 计划未 ack → RISK_REQUIRES_ACK", code2 === "RISK_REQUIRES_ACK", "code=" + code2);
    const confirmed = structure.confirmImportPlan(repo, warnPlan.id, { riskAck: true });
    const rj = JSON.parse(confirmed.plan.risk_json || "{}");
    check("R10b", "RISK", "riskAck 后 → ready 且 risk_json 记 risk_ack_at/risk_ack_digest",
      String(confirmed.plan.status) === "ready" && !!rj.risk_ack_at && String(rj.risk_ack_digest) === "digest-x",
      "status=" + confirmed.plan.status + " ackAt=" + String(rj.risk_ack_at).slice(0, 19) + " digest=" + String(rj.risk_ack_digest));
    t.close();
  } catch (e) { fail("R9", "RISK", "风险门禁检查异常", String(e && e.stack || e)); }

  // ---- P：指纹变化阻断（既有能力，回归钉住） ----
  try {
    const single = join(WORK, "fp.unitypackage");
    copyFileSync(fixtures.ok_single, single);
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "ok_single");
      const view = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT });
      check("P1", "PLAN", "干净单包计划建立（ready）", view.plan.status === "ready", view.plan.status);
      appendFileSync(single, Buffer.alloc(64, 0x41));
      env.t.db.prepare("UPDATE assets SET size=?, mtime=? WHERE id=?").run(statSync(single).size, new Date(statSync(single).mtimeMs).toISOString(), env.assets.s);
      let code = null;
      try { structure.precheckImportPlan(env.repo, view.plan.id); } catch (e) { code = errCode(e); }
      check("P2", "PLAN", "指纹变化 → FINGERPRINT_CHANGED 且计划 blocked", code === "FINGERPRINT_CHANGED" && env.repo.getImportPlan(view.plan.id).status === "blocked", "code=" + code);
    } finally { env.t.close(); }
  } catch (e) { fail("P1", "PLAN", "指纹回归异常", String(e && e.stack || e)); }

  // ---- U：unknown 不重试 / 已执行计划不可二次执行 ----
  try {
    const single = join(WORK, "exec.unitypackage");
    copyFileSync(fixtures.ok_single, single);
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "ok_single");
      const v0 = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT });
      let view = (typeof structure.applyPlanRisk === "function" ? await structure.applyPlanRisk(env.repo, v0.plan.id) : null) ?? v0;
      if (["needs_confirmation", "blocked"].includes(String(view.plan.status))) {
        let confirmed = null;
        try { confirmed = structure.confirmImportPlan(env.repo, view.plan.id); } catch { confirmed = null; }
        if (confirmed) view = confirmed;
      }
      if (String(view.plan.status) === "blocked") {
        skip("U1", "UNKNOWN", "正常执行（风险 blocked）", "干净单包被风险判定 blocked（异常，见 R 区）；跳过执行断言");
        skip("U2", "UNKNOWN", "已执行计划不可二次执行", "同上");
        skip("U3", "UNKNOWN", "run_items 全终态", "同上");
      } else {
        const mock = mockUnity();
        const r1 = await structure.executeImportPlan({ repo: env.repo, unity: mock.unity, stagingDir: STAGING, waitMs: 0 }, view.plan.id);
        check("U1", "UNKNOWN", "正常执行完成且只发出 1 次 ImportPackage", mock.calls.importSent === 1 && ["done", "partial", "partial_success", "failed"].includes(String(r1.run.status)),
          "run=" + r1.run.status + " importCalls=" + mock.calls.importSent + " items=" + r1.items.map((i) => i.status + (i.error ? ":" + String(i.error).slice(0, 120) : "")).join(" | "));
        let code2 = null;
        try { await structure.executeImportPlan({ repo: env.repo, unity: mock.unity, stagingDir: STAGING, waitMs: 0 }, view.plan.id); } catch (e) { code2 = errCode(e); }
        check("U2", "UNKNOWN", "已执行计划不可二次执行（无第二次外部导入）", code2 === "PLAN_NOT_EXECUTABLE" && mock.calls.importSent === 1, "code=" + code2 + " importCalls=" + mock.calls.importSent);
        const run = env.repo.latestImportRun(view.plan.id);
        const items = env.repo.listImportRunItems(run.id);
        check("U3", "UNKNOWN", "run_items 全部终态（无 importing 半开）",
          items.length > 0 && items.every((i) => ["verified", "partial_success", "failed", "unknown", "cancelled"].includes(String(i.status))),
          items.map((i) => i.status).join(","));
      }
    } finally { env.t.close(); }
  } catch (e) { fail("U1", "UNKNOWN", "执行/no-retry 流程异常", String(e && e.stack || e)); }

  // ---- G：staging 台账 + 生命周期（FIX-2：cleanupStagingForRun / sweepStaging / 路由） ----
  try {
    const t = openTempDb(); const repo = new Repo(t.db);
    const root = join(TMP, "staging-ledger"); mkdirSync(root, { recursive: true });
    const f1 = join(root, "a.unitypackage");
    writeFileSync(f1, Buffer.alloc(16, 1));
    const r1 = repo.registerStagingFile({ path: f1, size: 16 });
    const r2 = repo.registerStagingFile({ path: f1, size: 32 });
    check("G1", "STAGING", "台账 path_norm 唯一（同路径重复登记 → 1 行、size 更新）", r1.id === r2.id && (repo.listStagingFiles({ limit: 10 }).length === 1) && Number(r2.size) === 32, "id=" + r1.id + " size=" + r2.size);
    repo.updateStagingFile(r1.id, { state: "cleanup_pending", cleanup_attempts: 1 });
    const row = repo.getStagingFile(r1.id);
    check("G2", "STAGING", "台账状态/重试计数可更新", row.state === "cleanup_pending" && Number(row.cleanup_attempts) === 1, row.state + "/" + row.cleanup_attempts);
    const stale = repo.listStaleStagingFiles("2999-01-01T00:00:00.000Z", 10);
    check("G3", "STAGING", "stale 查询按 last_used_at 截止（未来 cutoff → 命中）", stale.length >= 1, "rows=" + stale.length);
    check("G4", "STAGING", "台账行可删除", repo.deleteStagingFile(r1.id) === true, "");
    t.close();
  } catch (e) { fail("G1", "STAGING", "台账 CRUD 异常", String(e && e.stack || e)); }

  // G5/G6：cleanupStagingForRun 两分支（failed 保留供 7 天 sweep；partial_success 立即删）
  try {
    const t = openTempDb(); const repo = new Repo(t.db);
    const root = join(TMP, "stg-run"); mkdirSync(join(root, "unit-1"), { recursive: true });
    const f = join(root, "unit-1", "a.unitypackage"); writeFileSync(f, Buffer.alloc(8, 7));
    const planId = repo.createImportPlan({ itemId: addItem(t.db, { title: "stg" }), projectPath: PROJECT, status: "ready", precheck: {} }).id;
    const run = repo.createImportRun({ planId });
    repo.registerStagingFile({ path: f, size: 8, planId, runId: run.id, state: "in_use" });
    const keep = structure.cleanupStagingForRun(repo, run.id, "failed");
    check("G5", "STAGING", "cleanupStagingForRun(failed/unknown) 保留台账与文件（供 7 天 sweep）",
      keep.kept === 1 && keep.removed === 0 && existsSync(f) && !!repo.getStagingFileByPath(f), JSON.stringify(keep));
    const del = structure.cleanupStagingForRun(repo, run.id, "partial_success");
    check("G6", "STAGING", "cleanupStagingForRun(verified/partial_success) 删文件 + 删台账",
      del.removed === 1 && !existsSync(f) && repo.listStagingFiles({ runId: run.id }).length === 0, JSON.stringify(del));
    t.close();
  } catch (e) { fail("G5", "STAGING", "cleanupStagingForRun 流程异常", String(e && e.stack || e)); }

  // G7：执行集成——staging 产物登记 + 结束无 in_use 残留
  try {
    const single = join(WORK, "stage.unitypackage");
    copyFileSync(fixtures.ok_single, single);
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "ok_single");
      const v0 = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT });
      let view = (typeof structure.applyPlanRisk === "function" ? await structure.applyPlanRisk(env.repo, v0.plan.id) : null) ?? v0;
      if (["needs_confirmation", "blocked"].includes(String(view.plan.status))) {
        try { view = structure.confirmImportPlan(env.repo, view.plan.id, { riskAck: true }); } catch { /* blocked 留给 R9 */ }
      }
      if (String(view.plan.status) === "blocked") {
        blocked("G7", "STAGING", "执行时登记 staging 台账", "干净单包被风险 blocked（见 R 区），无法执行；跳过集成断言");
      } else {
        const mock = mockUnity();
        const run = (await structure.executeImportPlan({ repo: env.repo, unity: mock.unity, stagingDir: STAGING, waitMs: 0 }, view.plan.id)).run;
        const left = env.repo.listStagingFiles({ runId: Number(run.id), limit: 100 });
        check("G7", "STAGING", "执行结束无 in_use 残留（cleanupStagingForRun 已执行）",
          left.every((x) => ["cleanup_pending", "cleanup_failed"].includes(String(x.state))),
          "run=" + run.id + " status=" + run.status + " left=" + JSON.stringify(left.map((x) => x.state)));
      }
    } finally { env.t.close(); }
  } catch (e) { fail("G7", "STAGING", "执行登记流程异常", String(e && e.stack || e)); }

  // G8–G12：sweepStaging（dry-run / 正常清理 / 越界 / 活跃保护 / 符号链接）
  try {
    const t = openTempDb(); const repo = new Repo(t.db);
    const stagingDir = join(TMP, "sweep"); mkdirSync(join(stagingDir, "u1"), { recursive: true });
    const inside = join(stagingDir, "u1", "old.unitypackage"); writeFileSync(inside, "x");
    const rowIn = repo.registerStagingFile({ path: inside, size: 1 });
    repo.updateStagingFile(rowIn.id, { last_used_at: "2000-01-01T00:00:00.000Z", state: "cleanup_pending" });
    const dry = structure.sweepStaging(repo, stagingDir, { dryRun: true, olderThanDays: 0 });
    check("G8", "STAGING", "sweepStaging dryRun 只报告不删（文件/台账保留）",
      dry.candidates >= 1 && dry.removed === 0 && existsSync(inside) && !!repo.getStagingFileByPath(inside), JSON.stringify(dry));
    const real = structure.sweepStaging(repo, stagingDir, { olderThanDays: 0 });
    check("G9", "STAGING", "sweepStaging 过期清理（删文件 + 删台账）",
      real.removed === 1 && !existsSync(inside) && !repo.getStagingFileByPath(inside), JSON.stringify(real));

    const outside = join(TMP, "outside-sweep.bin"); writeFileSync(outside, "y");
    const rowOut = repo.registerStagingFile({ path: outside, size: 1 });
    repo.updateStagingFile(rowOut.id, { last_used_at: "2000-01-01T00:00:00.000Z", state: "cleanup_pending" });
    const sw2 = structure.sweepStaging(repo, stagingDir, { olderThanDays: 0 });
    check("G10", "STAGING", "越界路径不删（stagingDir 之外）且记 skipped/errors",
      existsSync(outside) && sw2.skipped >= 1 && sw2.errors.some((e2) => /越界/.test(e2)), JSON.stringify({ skipped: sw2.skipped, errors: sw2.errors }).slice(0, 200));

    const active = join(stagingDir, "u2", "active.unitypackage"); mkdirSync(join(stagingDir, "u2"), { recursive: true }); writeFileSync(active, "z");
    const planId = repo.createImportPlan({ itemId: addItem(t.db, { title: "run" }), projectPath: PROJECT, status: "running", precheck: {} }).id;
    const run = repo.createImportRun({ planId });
    repo.updateImportRun(run.id, { status: "running" });
    const rowActive = repo.registerStagingFile({ path: active, size: 1, planId, runId: run.id, state: "in_use" });
    repo.updateStagingFile(rowActive.id, { last_used_at: "2000-01-01T00:00:00.000Z" });
    const sw3 = structure.sweepStaging(repo, stagingDir, { olderThanDays: 0 });
    check("G11", "STAGING", "活跃执行中的 staging 不清理（run.status=running）",
      existsSync(active) && sw3.skipped >= 1 && !!repo.getStagingFileByPath(active), JSON.stringify({ skipped: sw3.skipped, removed: sw3.removed }));

    const link = join(stagingDir, "u3", "link.unitypackage"); mkdirSync(join(stagingDir, "u3"), { recursive: true });
    symlinkSync(outside, link);
    const rowLink = repo.registerStagingFile({ path: link, size: 1 });
    repo.updateStagingFile(rowLink.id, { last_used_at: "2000-01-01T00:00:00.000Z", state: "cleanup_pending" });
    const sw4 = structure.sweepStaging(repo, stagingDir, { olderThanDays: 0 });
    check("G12", "STAGING", "符号链接拒绝清理（lstat isSymbolicLink）",
      existsSync(outside) && sw4.errors.some((e2) => /符号链接/.test(e2)), JSON.stringify(sw4.errors).slice(0, 200));
    t.close();
  } catch (e) { fail("G8", "STAGING", "sweepStaging 流程异常", String(e && e.stack || e)); }

  // G13：路由存在（源码 + bundle 标记）
  try {
    const src = readFileSync(join(REPO, "apps/server/src/http/routes.ts"), "utf8");
    const bundle = readFileSync(join(REPO, "apps/desktop/build/server.mjs"), "utf8");
    check("G13", "STAGING", "路由 GET /api/staging 与 POST /api/staging/cleanup 存在（源码 + bundle）",
      src.includes('app.get("/api/staging"') && src.includes('app.post("/api/staging/cleanup"') && bundle.includes("/api/staging"),
      "src=" + src.includes('app.get("/api/staging"') + "/" + src.includes('app.post("/api/staging/cleanup"') + " bundle=" + bundle.includes("/api/staging"));
  } catch (e) { fail("G13", "STAGING", "路由存在性检查异常", String(e && e.stack || e)); }

  // ---- B：构建一致性（FIX-3，可先做只读核对） ----
  try {
    const bundle = join(REPO, "apps/desktop/build/server.mjs");
    const bundleSchema = join(REPO, "apps/desktop/build/schema.sql");
    const srcSchema = join(REPO, "apps/server/src/db/schema.sql");
    check("B1", "BUILD", "bundle 与 schema.sql 产物存在", existsSync(bundle) && existsSync(bundleSchema), bundle);
    if (existsSync(bundle)) {
      const text = readFileSync(bundle, "utf8");
      check("B2", "BUILD", "bundle 含 v0.7.x 路由标记（/api/import-plans、/api/import-runs）", text.includes("/api/import-plans") && text.includes("/api/import-runs"), "import-plans=" + text.includes("/api/import-plans") + " import-runs=" + text.includes("/api/import-runs"));
    } else skip("B2", "BUILD", "bundle 路由标记", "bundle 不存在（先跑 node apps/desktop/build.mjs）");
    if (existsSync(bundleSchema) && existsSync(srcSchema)) {
      const same = Buffer.compare(readFileSync(bundleSchema), readFileSync(srcSchema)) === 0;
      check("B3", "BUILD", "构建产物 schema.sql 与源码 byte-equal", same,
        same ? "identical" : "DIFFER（源码 " + statSync(srcSchema).size + "B vs 产物 " + statSync(bundleSchema).size + "B；改了 schema 后需重新构建）");
    } else skip("B3", "BUILD", "schema.sql 一致性", "产物缺失");
    const verify = join(REPO, "scripts/verify-build.mjs");
    if (!existsSync(verify)) fail("B4", "BUILD", "scripts/verify-build.mjs 存在", "缺失（FIX-3 未落地）");
    else {
      const r = spawnSync(process.execPath, [verify], { cwd: REPO, encoding: "utf8", timeout: 120000 });
      const out = String(r.stdout || r.stderr || "").trim().split("\n");
      check("B4", "BUILD", "scripts/verify-build.mjs 通过（bundle/路由/version/sha256/schema）", r.status === 0 && /BUILD OK/.test(String(r.stdout)), "status=" + r.status + " " + out.slice(-2).join(" / ").slice(0, 240));
    }
  } catch (e) { fail("B1", "BUILD", "构建一致性检查异常", String(e && e.stack || e)); }

  // ---- M：run_item 状态机终态（task-51 回归） ----
  try {
    const single = join(WORK, "machine.unitypackage");
    copyFileSync(fixtures.ok_single, single);
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = importableUnit(env, "ok_single");
      const planId = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT }).plan.id;
      const pi = env.repo.listImportPlanItems(planId)[0];
      const run = env.repo.createImportRun({ planId });
      const ri = env.repo.addImportRunItem({ runId: run.id, planItemId: pi.id, unitId: pi.unit_id });
      structure.transitionRunItem(env.repo, ri.id, "importing");
      structure.transitionRunItem(env.repo, ri.id, "unknown");
      let code = null;
      try { structure.transitionRunItem(env.repo, ri.id, "verified"); } catch (e) { code = errCode(e); }
      check("M1", "MACHINE", "importing→unknown 允许；unknown 终态（→verified 抛 INVALID_TRANSITION）", code === "INVALID_TRANSITION", "code=" + code);
      // 第二个终端状态样本必须用独立 plan（UNIQUE(plan_id,unit_id) / UNIQUE(run_id,plan_item_id)）
      const planId2 = structure.createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: PROJECT }).plan.id;
      const pi2 = env.repo.listImportPlanItems(planId2)[0];
      const run2 = env.repo.createImportRun({ planId: planId2 });
      const ri2 = env.repo.addImportRunItem({ runId: run2.id, planItemId: pi2.id, unitId: pi2.unit_id });
      structure.transitionRunItem(env.repo, ri2.id, "cancelled");
      let code2 = null;
      try { structure.transitionRunItem(env.repo, ri2.id, "verified"); } catch (e) { code2 = errCode(e); }
      check("M2", "MACHINE", "cancelled 终态（→verified 抛 INVALID_TRANSITION）", code2 === "INVALID_TRANSITION", "code=" + code2);
    } finally { env.t.close(); }
  } catch (e) { fail("M1", "MACHINE", "状态机检查异常", String(e && e.stack || e)); }

  // ---- X：无法自动化的真实环境项（BLOCKED；strict 不计入） ----
  blocked("X1", "UNITY", "真实 Unity ImportPackage 端到端（AssetDatabase 实际导入 / 控制台 / GUID 验证）",
    "MCP 离线，沿用 v0.7.0 UNVERIFIED；需在 Windows + Unity Editor 跑 scripts/acceptance.sh 或 scripts/win-acceptance.cmd");
  blocked("X2", "UNITY", "Windows 生产卷上的 staging 磁盘峰值（F8）",
    "本机 tmpfs 不能代表 NTFS 配额/磁盘压力；需在准生产环境测");

  // ---- 汇总 ----
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  // BLOCKED = 本环境无法自动化（真实 Unity/Windows 卷）；strict 只把 SKIP 视为失败
  const banner = counts.FAIL ? "FAIL" : (counts.SKIP && STRICT ? "SKIP(FAIL-strict)" : "PASS");
  console.log("\n" + JSON.stringify(counts));
  console.log(banner + " " + (counts.PASS || 0) + " passed / " + (counts.FAIL || 0) + " failed / " + (counts.SKIP || 0) + " skipped / " + (counts.BLOCKED || 0) + " blocked");
  writeReport(counts, banner);
  if (!KEEP) rmSync(TMP, { recursive: true, force: true });
  process.exit(counts.FAIL > 0 || (STRICT && counts.SKIP > 0) ? 1 : 0);
}

function writeReport(counts, banner) {
  const outDir = join(REPO, "test/acceptance-v071");
  mkdirSync(outDir, { recursive: true });
  const now = new Date().toISOString();
  const md = [];
  md.push("# v0.7.1 独立验收明细（task-55）");
  md.push("");
  md.push("> 自动生成：\`node --import tsx scripts/acceptance-v071.mjs\`；" + now);
  md.push("> 结果：**" + banner + "**（PASS " + (counts.PASS || 0) + " / FAIL " + (counts.FAIL || 0) + " / SKIP " + (counts.SKIP || 0) + " / BLOCKED " + (counts.BLOCKED || 0) + "）");
  md.push("> BLOCKED = 本环境无法自动化（真实 Unity / Windows 生产卷），不计入 strict 失败。");
  md.push("> 全部使用 os.tmpdir() 临时 SQLite 与临时 staging；未访问生产 data。");
  md.push("");
  md.push("| ID | 区域 | 断言 | 结果 | 证据/备注 |");
  md.push("|---|---|---|---|---|");
  for (const r of rows) md.push("| " + r.id + " | " + r.area + " | " + r.desc.replace(/\|/g, "\\|") + " | " + r.status + " | " + String(r.detail).replace(/\|/g, "\\|").slice(0, 400) + " |");
  md.push("");
  writeFileSync(join(outDir, "REPORT.md"), md.join("\n") + "\n");
  writeFileSync(join(outDir, "last-run.json"), JSON.stringify({ at: now, banner, counts, rows }, null, 2));
  console.log("wrote test/acceptance-v071/REPORT.md");
}

main().catch((e) => { console.error(e); process.exit(2); });
