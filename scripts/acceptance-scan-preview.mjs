// 扫描变更中心（M1）验收脚本 —— 端到端可复现。
//
// 用法：node --import tsx scripts/acceptance-scan-preview.mjs
// 覆盖：建预览（幂等）→ 分页 → 按类型勾选 → apply（真实入库）→ 已应用不可重复 →
//       文件变化后 stale 拒绝 → 取消/删除。
// 全部在临时数据目录里跑，不动你的库；素材用脚本自己生成的合法 zip。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startAssetVault } from "../apps/server/src/server.ts";

const require = createRequire(import.meta.url);
const z7 = require("7zip-bin").path7za;
const DIR = join(tmpdir(), "av-accept-preview-" + Date.now());
const SRC = join(DIR, "src");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + " " + JSON.stringify(x).slice(0, 240)); } };

function makeZip(dir, name, seed) {
  const work = join(dir, "work-" + name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "note.txt"), "seed " + seed + " " + "x".repeat(200 + seed));
  const out = join(dir, name);
  execFileSync(z7, ["a", "-tzip", "-mx=1", out, "note.txt"], { cwd: work, stdio: "ignore" });
  return out;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  for (let i = 1; i <= 3; i++) makeZip(SRC, "pack" + i + ".zip", i);

  const h = await startAssetVault({ port: 7425, dataDir: join(DIR, "data"), listen: true, logsDir: join(DIR, "data", "logs") });
  const api = async (m, p, b) => {
    const r = await fetch(h.url + p, { method: m, headers: b === undefined ? {} : { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body: j };
  };
  const waitJob = async (jobId) => {
    if (!jobId) return null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const js = await api("GET", "/api/jobs?limit=200");
      const j = (js.body?.jobs ?? []).find((x) => x.id === jobId);
      if (j && ["done", "failed", "cancelled", "abandoned"].includes(j.state)) return j;
    }
    return null;
  };
  try {
    console.log("== A. 建预览（幂等）==");
    const c = await api("POST", "/api/scan/previews", { path: SRC });
    ok("POST /api/scan/previews → 202", c.status === 202 && !!c.body?.previewId, c);
    ok("预览作业 done", (await waitJob(c.body.jobId))?.state === "done");
    const d = await api("GET", "/api/scan/previews/" + c.body.previewId);
    ok("state=ready", d.body?.preview?.state === "ready", d.body?.preview?.state);
    ok("counts.new=3", d.body?.preview?.counts?.new === 3, d.body?.preview?.counts);
    ok("planHash 存在", !!d.body?.preview?.plan_hash);
    const again = await api("POST", "/api/scan/previews", { path: SRC });
    ok("同参数重复创建 → existing:true", again.body?.existing === true && again.body.previewId === c.body.previewId, again.body);

    console.log("== B. 条目分页 + 勾选 ==");
    const items = await api("GET", "/api/scan/previews/" + c.body.previewId + "/items?limit=2");
    ok("keyset 分页返 2 条 + nextCursor", items.body?.items?.length === 2 && items.body?.nextCursor > 0);
    ok("条目字段齐全（change/path/size/mtime）", !!items.body.items[0].change && !!items.body.items[0].path && typeof items.body.items[0].size === "number");
    ok("按类型勾选 3 条", (await api("POST", "/api/scan/previews/" + c.body.previewId + "/items", { change: "new", decision: "accept" })).body?.updated === 3);

    console.log("== C. apply ==");
    const ap = await api("POST", "/api/scan/previews/" + c.body.previewId + "/apply", { planHash: d.body.preview.plan_hash });
    ok("apply → 202", ap.status === 202 && !!ap.body?.jobId, ap);
    ok("apply 作业 done", (await waitJob(ap.body.jobId))?.state === "done");
    const d2 = await api("GET", "/api/scan/previews/" + c.body.previewId);
    ok("预览 → applied", d2.body?.preview?.state === "applied", d2.body?.preview?.state);
    ok("itemCounts.applied=3", d2.body?.preview?.itemCounts?.applied === 3, d2.body?.preview?.itemCounts);
    const stats = await api("GET", "/api/stats");
    ok("库里真实新增 3 条目 / 3 资产", stats.body?.items === 3 && stats.body?.assets === 3, stats.body);
    ok("apply 批次 done", (d2.body?.applies ?? [])[0]?.state === "done");

    console.log("== D. 已应用不可重复 ==");
    ok("再次 apply → 409", (await api("POST", "/api/scan/previews/" + c.body.previewId + "/apply", {})).status === 409);

    console.log("== E. 文件变化 → stale ==");
    const S2 = join(DIR, "src2"); mkdirSync(S2, { recursive: true });
    const z = makeZip(S2, "only.zip", 9);
    const c3 = await api("POST", "/api/scan/previews", { path: S2 });
    await waitJob(c3.body.jobId);
    const d3 = await api("GET", "/api/scan/previews/" + c3.body.previewId);
    ok("新目录 ready + 1 new", d3.body?.preview?.state === "ready" && d3.body?.preview?.counts?.new === 1);
    await api("POST", "/api/scan/previews/" + c3.body.previewId + "/items", { change: "new", decision: "accept" });
    appendFileSync(z, Buffer.from("tampered"));
    const ap3 = await api("POST", "/api/scan/previews/" + c3.body.previewId + "/apply", { planHash: d3.body.preview.plan_hash });
    ok("文件变化后 apply 拒绝且 stale=1", ap3.status === 400 && ap3.body?.error?.stale === 1, ap3.body);

    console.log("== F. 取消 / 删除 ==");
    ok("cancel 200", (await api("POST", "/api/scan/previews/" + c3.body.previewId + "/cancel")).status === 200);
    ok("DELETE 200/{deleted:true}", (await api("DELETE", "/api/scan/previews/" + c3.body.previewId)).body?.deleted === true);
    ok("预览不存在 → 404", (await api("GET", "/api/scan/previews/" + c3.body.previewId)).status === 404);
  } finally {
    await h.close();
    rmSync(DIR, { recursive: true, force: true });
  }
  console.log("\n===== 扫描变更中心验收: pass=" + pass + " fail=" + fail + " =====");
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error("ERROR", e); process.exit(1); });
