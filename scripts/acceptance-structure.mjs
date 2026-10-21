#!/usr/bin/env node
/**
 * v0.7.0 结构验收（task-40 / verifier，独立于实现者）
 *
 * 用法：
 *   node --import tsx scripts/acceptance-structure.mjs            # 生成夹具到临时目录并验收
 *   node --import tsx scripts/acceptance-structure.mjs --fixtures test/fixtures/structure/out
 *   node --import tsx scripts/acceptance-structure.mjs --strict   # SKIP 也视为失败（e2e 阶段用）
 *
 * 设计：
 *  - 夹具 A/B/C/D/E 由 test/fixtures/structure/generate.mjs 生成（真实 zip / tar.gz unitypackage，含
 *    <guid>/pathname、<guid>/asset、<guid>/asset.meta + guid）；不 mock。
 *  - 真实解析：packages/core/src/archive/list.ts 的 listArchive/readArchiveEntry、
 *    packages/core/src/unitypackage.ts 的 listUnityPackage、sha256File。
 *  - policy/evidence/relations 断言依赖 packages/core/src/structure.ts（task-37）；未落地时标 SKIP，
 *    不伪造通过。plan/preflight/e2e 依赖 task-38，标 SKIP（PENDING）。
 *  - 报告：test/acceptance-structure/REPORT.md + last-run.json；控制台打印 pass/fail/skip 明细。
 */
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listArchive, readArchiveEntry, detectContainer } from "../packages/core/src/archive/list.ts";
import { listUnityPackage } from "../packages/core/src/unitypackage.ts";
import { sha256File } from "../packages/core/src/hash.ts";
import { isSubPath, normalizePath } from "../packages/core/src/pathnorm.ts";
import { generateFixtures } from "../test/fixtures/structure/generate.mjs";
import { openTempDb, addAsset, addAvatar, addItem, addRoot } from "../test/schema/_db";
import { Repo } from "../apps/server/src/db/repo";
import { analyzeItemStructure, createImportPlan, precheckImportPlan, executeImportPlan, getPlanView } from "../apps/server/src/services/structure";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith("--")) { args[key] = argv[++i]; continue; }
    args[key] = true;
  }
}
const STRICT = !!args.strict;
const rows = [];
function record(id, area, desc, status, detail = "") {
  rows.push({ id, area, desc, status, detail });
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "•";
  console.log("  " + mark + " " + status.padEnd(4) + " " + id + " " + desc + (detail ? " — " + detail : ""));
}
const pass = (id, area, desc, detail) => record(id, area, desc, "PASS", detail);
const fail = (id, area, desc, detail) => record(id, area, desc, "FAIL", detail);
const skip = (id, area, desc, detail) => record(id, area, desc, "SKIP", detail);
const check = (id, area, desc, ok, detail) => (ok ? pass : fail)(id, area, desc, detail);

const tmp = mkdtempSync(join(tmpdir(), "av-structure-"));
const fixturesDir = args.fixtures ? resolve(REPO, String(args.fixtures)) : join(tmp, "fixtures");
const work = join(tmp, "work"); mkdirSync(work, { recursive: true });
let fixtures = [];

function fileOf(name) {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error("missing fixture " + name);
  return f.path;
}
async function extractToTmp(zip, entry, name) {
  const buf = await readArchiveEntry(zip, entry, 64 * 1024 * 1024);
  const out = join(work, name);
  writeFileSync(out, buf);
  return { path: out, bytes: buf.length };
}
function errCode(e) { return String((e && (e.code || e.name)) || e); }

async function main() {
  console.log("fixtures ->", fixturesDir);
  fixtures = await generateFixtures(fixturesDir);
  console.log("fixtures:", fixtures.map((f) => f.name + "(" + f.size + "B)").join(", "));

  // ---------- 全局：原始文件 hash / mtime 不因解析改变 ----------
  const before = new Map();
  for (const f of fixtures) before.set(f.name, { sha: await sha256File(f.path), mtime: statSync(f.path).mtimeMs });
  const hashes = {};
  let D_UNITS = [];

  // ---------- A：外层 zip 含 2+ 独立 upkg ----------
  {
    const p = fileOf("A_multi_container.zip");
    const L = await listArchive(p);
    const upkgs = L.entries.filter((e) => /\.unitypackage$/i.test(e.path));
    check("A-1", "A", "listArchive(zip) 成功、container=zip", L.container === "zip" && L.entries.length === 4, "entries=" + L.entries.length);
    check("A-2", "A", "识别 3 个独立 .unitypackage + 1 个说明.pdf", upkgs.length === 3 && L.entries.some((e) => e.path.endsWith(".pdf")), upkgs.map((e) => e.path).join(" | "));
    const parsed = [];
    for (const [i, e] of upkgs.entries()) {
      const ex = await extractToTmp(p, e.path, "A-" + i + ".unitypackage");
      const U = await listUnityPackage(ex.path);
      parsed.push(U);
      check("A-3." + (i + 1), "A", "条目可独立提取并解析（" + e.path + "）", !U.truncated && U.assets.length === 1, "assets=" + U.assets.length + " assetPath=" + (U.assets[0] && U.assets[0].assetPath));
    }
    check("A-4", "A", "A 的 3 个包各自单 Avatar、可独立选择（可选）", parsed.every((U) => U.assets.length === 1), "units=3");
  }

  // ---------- B：单个 upkg 内混合 2 个 Avatar ----------
  {
    const p = fileOf("B_mixed.unitypackage");
    const U = await listUnityPackage(p);
    const paths = U.assets.map((a) => a.assetPath);
    check("B-1", "B", "单个 upkg 解析出 2 个资产路径（Manuka + Kikyo）",
      U.assets.length === 2 && paths.some((x) => /Manuka/i.test(x)) && paths.some((x) => /Kikyo/i.test(x)), paths.join(" | "));
    check("B-2", "B", "B 是单文件、不可拆分（结构事实）", statSync(p).isFile() && U.assets.length === 2, "同一 upkg 内 2 个 Avatar");
  }

  // ---------- C：zip 内只含 B（混合包） ----------
  {
    const p = fileOf("C_container_mixed.zip");
    const L = await listArchive(p);
    const upkgs = L.entries.filter((e) => /\.unitypackage$/i.test(e.path));
    check("C-1", "C", "外层 zip 只有 1 个 upkg 条目", upkgs.length === 1, "entries=" + L.entries.length);
    const ex = await extractToTmp(p, upkgs[0].path, "C-inner.unitypackage");
    const U = await listUnityPackage(ex.path);
    check("C-2", "C", "内部包解析出 2 个 Avatar（混合），外层不得当 multi 拆", U.assets.length === 2, U.assets.map((a) => a.assetPath).join(" | "));
  }

  // ---------- D：同商品 模型/材质/贴图 ----------
  {
    const p = fileOf("D_companion.zip");
    const L = await listArchive(p);
    const upkgs = L.entries.filter((e) => /\.unitypackage$/i.test(e.path));
    const units = [];
    for (const [i, e] of upkgs.entries()) {
      const ex = await extractToTmp(p, e.path, "D-" + i + ".unitypackage");
      const U = await listUnityPackage(ex.path);
      units.push({ path: e.path, name: e.path.split("/").pop().replace(/\.unitypackage$/i, ""), assetPath: U.assets[0] && U.assets[0].assetPath, assetCount: U.assets.length });
    }
    check("D-1", "D", "3 个独立 upkg（模型/材质/贴图）均单资产", upkgs.length === 3 && units.every((u) => u.assetCount === 1), units.map((u) => u.path).join(" | "));
    check("D-2", "D", "D 的资产路径同属一个 Avatar（Manuka），无跨 Avatar 混入", units.every((u) => /Manuka/i.test(String(u.assetPath))), units.map((u) => u.assetPath).join(" | "));
    D_UNITS = units;
  }

  // ---------- E1：损坏 zip ----------
  {
    const p = fileOf("E1_corrupt.zip");
    let code = null;
    try { await listArchive(p); } catch (e) { code = errCode(e); }
    check("E1", "E", "损坏 zip → 解析抛错（不返回伪造结果）", code && /NOT_AN_ARCHIVE|INVALID|BAD/i.test(code), "code=" + code);
  }

  // ---------- E2：截断 unitypackage ----------
  {
    const p = fileOf("E2_truncated.unitypackage");
    let code = null, partial = null;
    try { const U = await listUnityPackage(p); partial = U; } catch (e) { code = errCode(e); }
    check("E2", "E", "截断 upkg → 抛错或明确 truncated（不伪造完整）", !!code || (partial && (partial.truncated || partial.assets.length < 2)), "code=" + code + (partial ? " truncated=" + partial.truncated + " assets=" + partial.assets.length : ""));
  }

  // ---------- E3：超限（条目数 / 单条目字节） ----------
  {
    const p = fileOf("E3_overlimit.zip");
    const L1 = await listArchive(p, { maxEntries: 50 });
    check("E3-1", "E", "条目数 > maxEntries → truncated + limited ENTRIES", L1.truncated === true && L1.limited && L1.limited.code === "ENTRIES", "entries=" + L1.entries.length + " limited=" + JSON.stringify(L1.limited));
    const L2 = await listArchive(p, { maxEntryBytes: 1024 });
    check("E3-2", "E", "单条目 2048B > maxEntryBytes=1024 → limited BYTES（仍列出目录）", L2.limited && L2.limited.code === "BYTES" && L2.entries.length >= 60, "limited=" + JSON.stringify(L2.limited));
  }

  // ---------- E4：zip-slip ----------
  {
    const p = fileOf("E4_zipslip.zip");
    const L = await listArchive(p);
    const bad = L.entries.find((e) => e.path.includes(".."));
    const base = dirname(p);
    check("E4-1", "E", "zip-slip 条目在目录层被剔除（不暴露越界路径）", !bad, "entries=" + JSON.stringify(L.entries.map((e) => e.path)));
    let code = null;
    try { await readArchiveEntry(p, "../../../evil.unitypackage", 1024 * 1024); } catch (e) { code = errCode(e); }
    check("E4-2", "E", "显式读取越界条目被拒绝（不存在/非法输入）", !!code && /NOT_FOUND|INVALID|NOT_AN_ARCHIVE/i.test(code), "code=" + code);
    check("E4-3", "E", "若路径逃逸，isSubPath 可判定（防御对照）", !isSubPath(resolve(base, "../../../evil.unitypackage"), base), "normalized=" + normalizePath("../../../evil.unitypackage"));
  }

  // ---------- E5：嵌套 3 层 ----------
  {
    let p = fileOf("E5_nested3.zip");
    let depth = 0, lastUpkg = null;
    for (let i = 0; i < 4; i++) {
      const L = await listArchive(p);
      const inner = L.entries.find((e) => /\.(zip|unitypackage)$/i.test(e.path));
      if (!inner) break;
      depth++;
      const ex = await extractToTmp(p, inner.path, "E5-L" + depth + "-" + i + (inner.path.endsWith(".unitypackage") ? ".unitypackage" : ".zip"));
      if (/.unitypackage$/i.test(inner.path)) { lastUpkg = ex.path; break; }
      p = ex.path;
    }
    const U = lastUpkg ? await listUnityPackage(lastUpkg) : null;
    check("E5-1", "E", "嵌套 3 层可逐层解出 upkg", depth === 3 && !!lastUpkg && U && U.assets.length === 1, "depth=" + depth + " assets=" + (U ? U.assets.length : "n/a"));
  }

  // ---------- E6：解析期间文件被改 ----------
  {
    const src = fileOf("B_mixed.unitypackage");
    const dst = join(work, "E6_changed.unitypackage");
    copyFileSync(src, dst);
    const h1 = await sha256File(dst);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(dst, Buffer.alloc(256, 0x7a));
    const h2 = await sha256File(dst);
    let code = null, U = null;
    try { U = await listUnityPackage(dst); } catch (e) { code = errCode(e); }
    check("E6-1", "E", "文件被改后 sha256 变化（指纹可检出）", h1 !== h2, h1.slice(0, 16) + " -> " + h2.slice(0, 16));
    check("E6-2", "E", "被改后的文件不再被当作完整包（抛错或 truncated/assets 变化）", !!code || (U && (U.truncated || U.assets.length !== 2)), "code=" + code + (U ? " truncated=" + U.truncated + " assets=" + U.assets.length : ""));
  }

  // ---------- 全局：解析后原始 hash / mtime 不变 ----------
  {
    let ok = true, detail = [];
    for (const f of fixtures) {
      if (f.name === "E6_changed.unitypackage") continue;
      const a = before.get(f.name);
      const b = { sha: await sha256File(f.path), mtime: statSync(f.path).mtimeMs };
      hashes[f.name] = b.sha;
      if (a.sha !== b.sha) { ok = false; detail.push(f.name + " sha changed"); }
      if (Math.abs(a.mtime - b.mtime) > 1) { ok = false; detail.push(f.name + " mtime changed"); }
    }
    check("G-1", "G", "全部夹具解析后原始 sha256 / mtime 不变（解析只读）", ok, detail.join("; "));
  }

  // ---------- policy / evidence / relations（依赖 core structure.ts） ----------
  const structurePath = join(REPO, "packages/core/src/structure.ts");
  let core = null;
  try { core = await import(pathToFileURL(structurePath).href); } catch { core = null; }
  if (!core) {
    skip("P-1", "POLICY", "A：zip 内 2+ 独立 upkg → multi_package_container", "packages/core/src/structure.ts 未落地（task-37 进行中）");
    skip("P-2", "POLICY", "B：单个 upkg 混合 2 Avatar → mixed_unitypackage", "同上");
    skip("P-3", "POLICY", "C：zip 内只含混合包 → mixed（外层 zip 不得当 multi 拆）", "同上");
    skip("P-4", "POLICY", "E1：损坏/失败解析 → unknown", "同上");
    skip("P-5", "POLICY", "E5：嵌套层数超限 → unknown（不伪造结构）", "同上");
    skip("P-6", "POLICY", "D：关系候选 suggested_companion/probable，不得 confirmed / 不跨 Avatar", "同上");
    skip("P-7", "POLICY", "evidence：别名/大小写/全半角/合并 hits/item_avatar=confirmed", "同上");
  } else {
    const avatars = [
      { id: 1, name: "Manuka", aliases: ["マヌカ", "manuka"] },
      { id: 2, name: "Kikyo", aliases: ["桔梗"] },
    ];
    const ev = core.detectUnitAvatars(["MANUKA.unitypackage", "マヌカ", "ＭＡＮＵＫＡ"], avatars);
    check("P-7", "POLICY", "evidence：别名/大小写/全半角命中并被合并", ev.length === 1 && ev[0].avatarId === 1 && ev[0].hits.length >= 2 && ev[0].level === "probable", JSON.stringify(ev));
    const ev2 = core.detectUnitAvatars([], avatars, [1]);
    check("P-8", "POLICY", "evidence：item_avatar 视为 confirmed", ev2.length === 1 && ev2[0].level === "confirmed" && ev2[0].via === "item_avatar", JSON.stringify(ev2));
    const pA = core.decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: ["a", "b", "c"], mixedAvatarCount: 0, parseState: "ok" });
    check("P-1", "POLICY", "A：zip 内 2+ 独立 upkg → multi_package_container", pA.policy === "multi_package_container", JSON.stringify(pA));
    const pB = core.decidePolicy({ container: "unitypackage", kind: "unitypackage", innerUnitypackagePaths: [], mixedAvatarCount: 2, parseState: "ok" });
    check("P-2", "POLICY", "B：单个 upkg 混合 2 Avatar → mixed_unitypackage", pB.policy === "mixed_unitypackage", JSON.stringify(pB));
    const pC = core.decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: ["b"], mixedAvatarCount: 2, parseState: "ok" });
    check("P-3", "POLICY", "C：zip 内只含混合包 → mixed（不是 multi）", pC.policy === "mixed_unitypackage", JSON.stringify(pC));
    const pE = core.decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "failed" });
    check("P-4", "POLICY", "E1：损坏/失败解析 → unknown", pE.policy === "unknown_structure", JSON.stringify(pE));
    const pE5 = core.decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "ok" });
    check("P-5", "POLICY", "E5：无直接 upkg（仅深层嵌套）→ unknown", pE5.policy === "unknown_structure", JSON.stringify(pE5));
    const unitsD = D_UNITS.map((u, i) => ({ id: "d" + i, name: u.name, avatarIds: [1], kind: "unitypackage" }));
    const rel = core.relationCandidates(unitsD);
    const allProbable = rel.length >= 2 && rel.every((r) => r.confidence === "probable");
    const hasCompanion = rel.some((r) => r.type === "suggested_companion");
    check("P-6", "POLICY", "D：模型/材质/贴图同 stem → suggested_companion/probable（无 confirmed）", allProbable && hasCompanion, "observedTypes=" + JSON.stringify(rel.map((r) => r.type)));
    const relCross = core.relationCandidates([
      { id: "m", name: "MANUKA_model", avatarIds: [1], kind: "unitypackage" },
      { id: "k", name: "KIKYO_model", avatarIds: [2], kind: "unitypackage" },
    ]);
    check("P-9", "POLICY", "D：跨 Avatar 不产出关系（不误配）", relCross.length === 0, JSON.stringify(relCross));
    const relVar = core.relationCandidates([
      { id: "v2", name: "Manuka_v2", avatarIds: [1], kind: "unitypackage" },
      { id: "v3", name: "Manuka_v3", avatarIds: [1], kind: "unitypackage" },
    ]);
    check("P-10", "POLICY", "同 Avatar 同名变体 → optional_variant/probable", relVar.length === 1 && relVar[0].type === "optional_variant" && relVar[0].confidence === "probable", JSON.stringify(relVar));
  }

  // ---------- e2e：计划 / 预检 / 执行（task-38/42；临时 SQLite + 真实 Repo/服务，无 HTTP） ----------
  const e2e = join(tmp, "e2e"); mkdirSync(e2e, { recursive: true });
  const project = join(e2e, "UnityProject"); mkdirSync(join(project, "Assets"), { recursive: true });
  const staging = join(e2e, "unity-staging");
  const copyFix = (name, as) => { const dst = join(e2e, as); copyFileSync(fileOf(name), dst); return dst; };
  async function seedEnv(specs) {
    const t = openTempDb(); const repo = new Repo(t.db);
    const rootId = addRoot(t.db, "/lib"); const itemId = addItem(t.db, { title: "e2e-" + Math.random().toString(36).slice(2) });
    addAvatar(t.db, "Manuka"); addAvatar(t.db, "Kikyo");
    const assets = {};
    for (const spec of specs) {
      const st = statSync(spec.path);
      const a = addAsset(t.db, itemId, rootId, spec.path, {
        kind: spec.kind, container: spec.container, path: spec.path, path_norm: spec.path,
        size: st.size, mtime: new Date(st.mtimeMs).toISOString(), sha256: await sha256File(spec.path),
      });
      if (spec.container !== "unitypackage") {
        const L = await listArchive(spec.path);
        for (const e of L.entries) t.db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,?,?,?)").run(a, e.path, e.size, e.isDir ? 1 : 0, e.path.includes(".") ? "." + e.path.split(".").pop() : null);
      } else {
        const U = await listUnityPackage(spec.path);
        repo.replaceUnityPackageAssets(a, U.assets.map((x) => ({ guid: x.guid, assetPath: x.assetPath, type: x.type, size: x.size, hasPreview: x.hasPreview })));
      }
      t.db.prepare("UPDATE assets SET index_state='done' WHERE id=?").run(a);
      assets[spec.key] = a;
    }
    await analyzeItemStructure(repo, itemId);
    return { t, repo, itemId, assets, units: repo.listUnits({ itemId }) };
  }
  const unitOf = (env, assetId) => env.units.find((u) => Number(u.asset_id) === assetId && Number(u.importable) === 1);
  const unavailableUnity = { endpoint: "mock", serverName: "mock", async csharp() { return ""; }, async call() { return { isError: true, text: "", structured: { data: [] } }; } };

  // B-1：2 个 unit 的 plan；includeSuggested=false 不含 suggested
  try {
    const env = await seedEnv([{ key: "d", path: copyFix("D_companion.zip", "D_companion.zip"), container: "zip", kind: "archive" }]);
    try {
      const importables = env.units.filter((u) => Number(u.importable) === 1 && String(u.policy) !== "unknown_structure");
      const byName = (n) => importables.find((u) => String(u.name).includes(n));
      const model = byName("MANUKA_model"), material = byName("MANUKA_material"), texture = byName("MANUKA_texture");
      check("B-1a", "PLAN", "D 分析出 3 个可导入单元（model/material/texture）", !!model && !!material && !!texture, env.units.map((u) => u.name + ":" + u.policy).join(" | "));
      const p1 = createImportPlan(env.repo, { unitIds: [Number(model.id), Number(material.id)], projectPath: project, includeSuggested: false });
      check("B-1b", "PLAN", "includeSuggested=false：计划只含 2 个选中单元、不含 suggested", p1.items.length === 2 && p1.items.every((it) => it.status !== "suggested"), JSON.stringify(p1.items.map((it) => it.unit_name + ":" + it.status)));
      check("B-1d", "PLAN", "计划内容 = 恰好 2 个选中单元，无无关单元", new Set(p1.items.map((it) => Number(it.unit_id))).size === 2 && [model, material].every((u) => p1.items.some((it) => Number(it.unit_id) === Number(u.id))), "planId=" + p1.plan.id);
      // 真实链路：analyze 生成的关系 → includeSuggested=true 自动加入伴生（选 模型+材质 → 建议贴图）
      const p2 = createImportPlan(env.repo, { unitIds: [Number(model.id), Number(material.id)], projectPath: project, includeSuggested: true });
      const sug = p2.items.filter((it) => it.status === "suggested");
      const rels = env.repo.listUnitRelations([Number(model.id), Number(material.id)]);
      check("B-1c", "PLAN", "includeSuggested=true（真实 analyze 关系）：加入伴生单元且标 suggested", p2.items.length === 3 && sug.length === 1 && p2.plan.status === "needs_confirmation" && Number(sug[0].unit_id) === Number(texture.id), "items=" + JSON.stringify(p2.items.map((it) => it.unit_name + ":" + it.status)) + " relations=" + rels.length);
      // 正例对照：人工关系（与后端单测同法）时 includeSuggested 必须生效（不依赖 analyze 方向）
      env.repo.replaceUnitRelations([Number(texture.id)], [{ fromUnitId: Number(texture.id), toUnitId: Number(material.id), type: "suggested_companion", evidence: "manual control", confidence: "probable" }]);
      const p3 = createImportPlan(env.repo, { unitIds: [Number(texture.id)], projectPath: project, includeSuggested: true });
      const sug3 = p3.items.filter((it) => it.status === "suggested");
      check("B-1e", "PLAN", "正例对照：有关系时 includeSuggested 加入且仅标 suggested", p3.items.length === 2 && sug3.length === 1 && p3.plan.status === "needs_confirmation", JSON.stringify(p3.items.map((it) => it.unit_name + ":" + it.status)));
    } finally { env.t.close(); }
  } catch (e) { fail("B-1", "PLAN", "B-1 执行异常", String((e && e.stack) || e)); }

  // B-2：mixed 单元计划引用原始整包、不产生筛选/暂存产物
  try {
    const mixedPath = copyFix("B_mixed.unitypackage", "B_mixed.unitypackage");
    const env = await seedEnv([{ key: "b", path: mixedPath, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = unitOf(env, env.assets.b);
      check("B-2a", "PLAN", "B 单元 policy=mixed_unitypackage 且可导入", u && u.policy === "mixed_unitypackage" && Number(u.importable) === 1, u && u.policy);
      const before = readdirSync(e2e).sort().join(",");
      const view = createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: project });
      const item = view.items[0];
      check("B-2b", "PLAN", "mixed plan_item.path === 原始整包路径", item && item.path === mixedPath, item && item.path);
      check("B-2c", "PLAN", "计划阶段不产生暂存/筛选包（目录未新增文件）", readdirSync(e2e).sort().join(",") === before && !String(item.path).includes("filtered"), "dirs=" + readdirSync(e2e).join(","));
      check("B-2d", "PLAN", "mixed 计划需人工确认（不自动执行）", view.plan.status === "needs_confirmation" && view.plan.policy === "mixed_unitypackage", view.plan.status);
    } finally { env.t.close(); }
  } catch (e) { fail("B-2", "PLAN", "B-2 执行异常", String((e && e.stack) || e)); }

  // B-3：建计划后改文件 → precheck/execute 均 blocked/FINGERPRINT_CHANGED
  try {
    const single = join(e2e, "single.unitypackage");
    writeFileSync(single, await readArchiveEntry(fileOf("D_companion.zip"), "MANUKA_model/MANUKA_model.unitypackage", 4 * 1024 * 1024));
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = unitOf(env, env.assets.s);
      const view = createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: project });
      check("B-3a", "PLAN", "单包计划建立（ready）", view.plan.status === "ready" && view.items.length === 1, view.plan.status);
      appendFileSync(single, Buffer.alloc(64, 0x41));
      // 模拟重扫描：真实流程由 scan/watcher 更新 assets.size/mtime；precheck 比较的是 DB 行与单元指纹
      env.t.db.prepare("UPDATE assets SET size=?, mtime=? WHERE id=?").run(statSync(single).size, new Date(statSync(single).mtimeMs).toISOString(), env.assets.s);
      let code = null;
      try { precheckImportPlan(env.repo, view.plan.id); } catch (e) { code = errCode(e); }
      check("B-3b", "PLAN", "改文件后 precheck → FINGERPRINT_CHANGED 且计划 blocked", code === "FINGERPRINT_CHANGED" && env.repo.getImportPlan(view.plan.id).status === "blocked", "code=" + code);
      let code2 = null;
      try { await executeImportPlan({ repo: env.repo, unity: unavailableUnity, stagingDir: staging, waitMs: 0 }, view.plan.id); } catch (e) { code2 = errCode(e); }
      check("B-3c", "PLAN", "execute 同样被拦截（不执行外部导入）", code2 === "FINGERPRINT_CHANGED" || code2 === "PLAN_BLOCKED", "code=" + code2);
    } finally { env.t.close(); }
  } catch (e) { fail("B-3", "PLAN", "B-3 执行异常", String((e && e.stack) || e)); }

  // B-4：Unity 不可用 → 执行被拦截；前后源文件 sha256 不变
  try {
    const single = join(e2e, "single-b4.unitypackage");
    writeFileSync(single, await readArchiveEntry(fileOf("D_companion.zip"), "MANUKA_model/MANUKA_model.unitypackage", 4 * 1024 * 1024));
    const env = await seedEnv([{ key: "s", path: single, container: "unitypackage", kind: "unitypackage" }]);
    try {
      const u = unitOf(env, env.assets.s);
      const view = createImportPlan(env.repo, { unitIds: [Number(u.id)], projectPath: project });
      const h0 = await sha256File(single);
      let code = null;
      try { await executeImportPlan({ repo: env.repo, unity: unavailableUnity, stagingDir: staging, waitMs: 0 }, view.plan.id); } catch (e) { code = errCode(e); }
      const h1 = await sha256File(single);
      check("B-4a", "PLAN", "Unity 不可用 → execute 被拦截（UNITY_UNAVAILABLE）", code === "UNITY_UNAVAILABLE", "code=" + code);
      check("B-4b", "PLAN", "执行前后源文件 sha256 不变", h0 === h1, h0.slice(0, 16) + " -> " + h1.slice(0, 16));
      // task-46：前置失败也要留可审计的 failed run + 逐项 run_items + plan.lastError（不再要求"无 run"）
      const pv = getPlanView(env.repo, view.plan.id);
      const run = pv.latestRun;
      const runItems = run ? env.repo.listImportRunItems(run.id) : [];
      const phase = run && run.summary ? run.summary.phase : null;
      check("B-4c", "PLAN", "前置失败落 failed run（summary.phase=preflight）", !!run && run.status === "failed" && phase === "preflight", "run=" + JSON.stringify(run && { id: run.id, status: run.status, phase }));
      check("B-4d", "PLAN", "每个 plan_item 一条 failed run_item（可审计）", runItems.length === view.items.length && runItems.every((ri) => ri.status === "failed" && String(ri.error || "").includes("UNITY_UNAVAILABLE")), "runItems=" + JSON.stringify(runItems.map((ri) => ri.status)));
      check("B-4e", "PLAN", "plan.lastError.code=UNITY_UNAVAILABLE（phase 见 run.summary）", pv.lastError && pv.lastError.code === "UNITY_UNAVAILABLE" && phase === "preflight", JSON.stringify(pv.lastError) + " summaryPhase=" + phase);
    } finally { env.t.close(); }
  } catch (e) { fail("B-4", "PLAN", "B-4 执行异常", String((e && e.stack) || e)); }

  // E5-2：嵌套上限（task-45：depth=3 / archives=32 / 512MB）
  //  - depth 3 可展开且 importable（真实大包场景）
  //  - depth 4 → limited、不可导入、建计划被拒
  try {
    const env3 = await seedEnv([{ key: "e5d3", path: copyFix("E5_nested3.zip", "E5_nested3.zip"), container: "zip", kind: "archive" }]);
    try {
      const importable = env3.units.filter((u) => Number(u.importable) === 1);
      const nested = importable.find((u) => String(u.rel_path || "").includes("::"));
      check("E5-2a", "E", "depth=3 嵌套 → 服务展开出可导入单元（rel_path 含 ::）", importable.length >= 1 && !!nested, env3.units.map((u) => (u.rel_path || "(container)") + ":" + u.policy + ":" + u.parse_state + ":imp=" + u.importable).join(" | "));
      let planItems = -1;
      try { planItems = createImportPlan(env3.repo, { unitIds: [Number(nested.id)], projectPath: project }).items.length; } catch { planItems = -1; }
      check("E5-2b", "E", "depth=3 单元可建计划（单条）", planItems === 1, "planItems=" + planItems);
    } finally { env3.t.close(); }
  } catch (e) { fail("E5-2a", "E", "E5-2 depth3 执行异常", String((e && e.stack) || e)); }
  try {
    const env4 = await seedEnv([{ key: "e5d4", path: copyFix("E5_depth4.zip", "E5_depth4.zip"), container: "zip", kind: "archive" }]);
    try {
      const limited = env4.units.filter((u) => String(u.parse_state) === "limited" || String(u.parse_state) === "failed");
      const importable = env4.units.filter((u) => Number(u.importable) === 1);
      check("E5-2c", "E", "depth=4 超过上限 → limited 单元、无可导入单元", limited.length >= 1 && importable.length === 0, env4.units.map((u) => (u.rel_path || "(container)") + ":" + u.policy + ":" + u.parse_state + ":imp=" + u.importable).join(" | "));
      let code = null;
      try { createImportPlan(env4.repo, { unitIds: [Number(limited[0].id)], projectPath: project }); } catch (e) { code = errCode(e); }
      check("E5-2d", "E", "超限单元建计划 → INVALID_INPUT（不伪造可执行计划）", code === "INVALID_INPUT", "code=" + code);
    } finally { env4.t.close(); }
  } catch (e) { fail("E5-2c", "E", "E5-2 depth4 执行异常", String((e && e.stack) || e)); }

  // ---------- 汇总 ----------
  const counts = rows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
  console.log("\n" + JSON.stringify(counts));
  const banner = counts.FAIL ? "FAIL" : (counts.SKIP && STRICT ? "SKIP(FAIL-strict)" : "PASS");
  console.log(banner + " " + (counts.PASS || 0) + " passed / " + (counts.FAIL || 0) + " failed / " + (counts.SKIP || 0) + " skipped");
  writeReport(counts, hashes, banner);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(counts.FAIL > 0 || (STRICT && counts.SKIP > 0) ? 1 : 0);
}

function writeReport(counts, hashes, banner) {
  const outDir = join(REPO, "test/acceptance-structure");
  mkdirSync(outDir, { recursive: true });
  const now = new Date().toISOString();
  const md = [];
  md.push("# v0.7.0 结构验收明细（task-40）");
  md.push("");
  md.push("> 自动生成：`node --import tsx scripts/acceptance-structure.mjs`；" + now);
  md.push("> 结果：**" + banner + "**（PASS " + (counts.PASS || 0) + " / FAIL " + (counts.FAIL || 0) + " / SKIP " + (counts.SKIP || 0) + "）");
  md.push("");
  md.push("## 夹具（真实 zip / tar.gz，含 asset.meta guid）");
  md.push("");
  md.push("| 文件 | 大小 | sha256 |");
  md.push("|---|---|---|");
  for (const name of Object.keys(hashes).sort()) {
    const f = fixtures.find((x) => x.name === name);
    md.push("| " + name + " | " + (f ? f.size : "?") + " | `" + hashes[name].slice(0, 32) + "…` |");
  }
  md.push("");
  md.push("## 明细");
  md.push("");
  md.push("| ID | 区域 | 断言 | 结果 | 证据/备注 |");
  md.push("|---|---|---|---|---|");
  for (const r of rows) md.push("| " + r.id + " | " + r.area + " | " + r.desc + " | " + r.status + " | " + String(r.detail).replace(/\|/g, "\\|") + " |");
  md.push("");
  md.push("## SKIP 说明");
  md.push("");
  md.push("- POLICY 组依赖 `packages/core/src/structure.ts`（task-37）。落地后重跑本脚本即自动启用；不伪造通过。");
  md.push("- PLAN 组依赖 task-38（结构服务/计划/预检 API）；后端就绪后补 e2e，本脚本已预留 ID（B-1..B-4）。");
  md.push("- `--strict` 会把 SKIP 视为失败，供 e2e 阶段使用。");
  writeFileSync(join(outDir, "REPORT.md"), md.join("\n") + "\n");
  writeFileSync(join(outDir, "last-run.json"), JSON.stringify({ at: now, banner, counts, rows, hashes }, null, 2));
  console.log("wrote", join(outDir, "REPORT.md"));
}

main().catch((e) => { console.error(e); process.exit(2); });
