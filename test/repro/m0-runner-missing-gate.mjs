/**
 * M0/P1 定点验证（scratch）：runner 的 missing 写入门控端到端行为。
 *   A) 树里有读取错误（ENTRY_STAT_ERROR）→ 未见资产**不得**被标 missing，且 job_events 里可查到 scan_incomplete。
 *   B) 干净的树里文件真的没了 → 仍要标 missing（AC7 语义不回退）。
 * 只用临时目录 + 临时库（openTempDb），不碰用户素材；不修改 apps/server/**。
 * 运行：node --import tsx test/repro/m0-runner-missing-gate.mjs
 */
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb } from "../schema/_db.ts";
import { Repo } from "../../apps/server/src/db/repo.ts";
import { runJob } from "../../apps/server/src/jobs/runner.ts";
import { normalizePath } from "../../packages/core/src/pathnorm.ts";

const REDACT = (s) => String(s).replaceAll(tmpdir(), "<TMP>");
const deps = (repo) => ({
  repo,
  media: new Proxy({}, { get: () => () => { throw new Error("media 不应被调用"); } }),
  booth: new Proxy({}, { get: () => () => { throw new Error("booth 不应被调用"); } }),
  log: (m) => console.log("   [log] " + REDACT(m)),
});

let all = true;
const check = (name, ok, extra = "") => { all = all && ok; console.log((ok ? "PASS" : "FAIL") + " | " + name + (extra ? "\n     " + extra : "")); };

async function scenarioA() {
  console.log("\n--- A) 目录项 stat 失败 → fail-closed（不写 missing）+ scan_incomplete 事件 ---");
  const t = openTempDb();
  const repo = new Repo(t.db);
  const root = mkdtempSync(join(tmpdir(), "av-m0-a-"));
  const zip = join(root, "real.zip");
  writeFileSync(zip, Buffer.from("PK"));
  const rootId = repo.ensureRoot(root, "index_in_place").id;
  const item = repo.createItem({ title: "m0-a", source_site: "local", status: "inbox" });
  const present = repo.upsertAsset({ item_id: item.id, kind: "archive", container: "zip", path: zip, path_norm: normalizePath(zip), root_id: rootId, size: 2, mtime: null, discovered_by: "scan" }).asset;
  // 一条"重扫时看不到、但属于本根"的资产：若门控失效，它会被标 missing
  const ghostPath = join(root, "sub", "gone.zip");
  const ghost = repo.upsertAsset({ item_id: item.id, kind: "archive", container: "zip", path: ghostPath, path_norm: normalizePath(ghostPath), root_id: rootId, size: 5, mtime: null, discovered_by: "scan" }).asset;
  // 让这一轮扫描出现读取错误：悬空符号链接会被 statSync 抛 ENOENT
  symlinkSync(join(root, "does-not-exist-target"), join(root, "dangling-link"));
  const job = repo.createJob("scan", null, { path: root, deep: true }, 3);
  await runJob(deps(repo), job.id);
  const after = repo.getJob(job.id);
  const ghostAfter = repo.getAsset(ghost.id);
  const presentAfter = repo.getAsset(present.id);
  const events = repo.listJobEvents(job.id);
  const inc = events.find((e) => e.event === "scan_incomplete");
  check("job 正常成功（不伪造失败）", after?.state === "done", "state=" + after?.state + " error=" + JSON.stringify(after?.error));
  check("未见资产未被标 missing", ghostAfter?.status === "present", "ghost.status=" + ghostAfter?.status);
  check("在树里的资产仍 present", presentAfter?.status === "present");
  check("job_events 可查到 scan_incomplete", !!inc, "events=" + JSON.stringify(events.map((e) => e.event)));
  if (inc) {
    let d = null; try { d = JSON.parse(inc.detail); } catch {}
    check("事件 detail 带原因与跳过数量", Array.isArray(d?.reasons) && d.reasons.length > 0 && typeof d.skippedMissing === "number", "detail=" + REDACT(inc.detail));
  }
  t.close();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

async function scenarioB() {
  console.log("\n--- B) 干净的树 + 文件真删除 → 仍标 missing（正例对照） ---");
  const t = openTempDb();
  const repo = new Repo(t.db);
  const root = mkdtempSync(join(tmpdir(), "av-m0-b-"));
  writeFileSync(join(root, "keep.zip"), Buffer.from("PK"));
  const rootId = repo.ensureRoot(root, "index_in_place").id;
  const item = repo.createItem({ title: "m0-b", source_site: "local", status: "inbox" });
  const gonePath = join(root, "gone.zip");
  const gone = repo.upsertAsset({ item_id: item.id, kind: "archive", container: "zip", path: gonePath, path_norm: normalizePath(gonePath), root_id: rootId, size: 9, mtime: null, discovered_by: "scan" }).asset;
  const job = repo.createJob("scan", null, { path: root, deep: true }, 3);
  await runJob(deps(repo), job.id);
  const after = repo.getJob(job.id);
  const goneAfter = repo.getAsset(gone.id);
  const events = repo.listJobEvents(job.id);
  check("job done", after?.state === "done", "state=" + after?.state);
  check("真实删除的资产被标 missing", goneAfter?.status === "missing", "status=" + goneAfter?.status);
  check("没有 scan_incomplete 事件", !events.some((e) => e.event === "scan_incomplete"), "events=" + JSON.stringify(events.map((e) => e.event)));
  t.close();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

await scenarioA();
await scenarioB();
console.log("\nVERDICT=" + (all ? "PASS" : "FAIL"));
process.exit(all ? 0 : 1);
