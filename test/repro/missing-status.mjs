/**
 * 最小复现 D6：磁盘文件被删除后重扫，assets.status 仍为 'present'（AC7 要求变 'missing'）
 * 只用 verifier 自己的临时根，安全。
 *   node test/repro/missing-status.mjs
 * 证据：docs/verification/evidence/missing-status.json
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMinimalZip } from "../smoke/_lib.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = (process.env.AV_BASE ?? "http://127.0.0.1:7317/api").replace(/\/$/, "");
const TMP = join(ROOT, "docs", "verification", "tmp", "repro-d6");
mkdirSync(TMP, { recursive: true });
const file = join(TMP, "d6-sample.zip");
writeFileSync(file, makeMinimalZip([{ name: "d6/readme.txt", data: Buffer.from("d6 " + Date.now()) }]));

const req = async (p, init = {}) => {
  const r = await fetch(BASE + p, { ...init, headers: { "content-type": "application/json" } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const post = (p, b) => req(p, { method: "POST", body: JSON.stringify(b) });
const get = (p) => req(p);
const waitJob = async (id, ms = 30000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const j = (await get("/jobs?limit=200")).body?.jobs?.find((x) => Number(x.id) === Number(id));
    if (j && ["done", "failed", "cancelled", "abandoned"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
};
const findAsset = async () => {
  const items = (await get("/items?limit=500")).body?.items ?? [];
  for (const it of items) {
    const d = (await get(`/items/${it.id}`)).body;
    const a = (d?.assets ?? []).find((x) => String(x.path).includes("d6-sample"));
    if (a) return a;
  }
  return null;
};

const out = { base: BASE, at: new Date().toISOString(), file, steps: [] };
const roots = (await get("/roots")).body?.roots ?? [];
let rootId = roots.find((r) => String(r.path).includes("repro-d6"))?.id;
if (!rootId) {
  const r = await post("/roots", { path: TMP, mode: "index_in_place" });
  rootId = r.body?.id ?? r.body?.root?.id;
  out.register = { status: r.status, body: r.body };
}
const scan = async (tag) => {
  const s = await post("/scan", { rootId, deep: true });
  const job = s.body?.jobId ? await waitJob(Number(s.body.jobId)) : null;
  const a = await findAsset();
  const step = { tag, job: job && { id: job.id, state: job.state, error: job.error, payload: post ? undefined : undefined }, asset: a && { id: a.id, status: a.status, last_verified_at: a.last_verified_at, path: a.path, sha256_state: a.sha256_state } };
  out.steps.push(step);
  return a;
};
const before = await scan("1-初始扫描（文件存在）");
rmSync(file);
const afterDelete = await scan("2-删除文件后重扫");
writeFileSync(file, makeMinimalZip([{ name: "d6/readme.txt", data: Buffer.from("d6 restored " + Date.now()) }]));
const afterRestore = await scan("3-恢复文件后重扫");
out.verdict = {
  initial: before?.status,
  afterDelete: afterDelete?.status,
  afterRestore: afterRestore?.status,
  expected: { initial: "present", afterDelete: "missing", afterRestore: "present" },
  pass: before?.status === "present" && afterDelete?.status === "missing" && afterRestore?.status === "present",
};
console.log(JSON.stringify(out, null, 2));
const { writeFileSync: wf } = await import("node:fs");
wf(join(ROOT, "docs", "verification", "evidence", "missing-status.json"), JSON.stringify(out, null, 2));
process.exitCode = out.verdict.pass ? 0 : 1;
