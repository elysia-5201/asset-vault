/**
 * 最小复现：扫描相关缺陷（verifier / task-4）
 *   D1 POST /scan {rootId, deep:true} → 作业 failed 且 error 为空
 *   D2 同一路径连续两次 /scan → assets 不增（幂等 OK）但 items 每次 +2（条目去重被破坏）
 * 用法：node test/repro/scan-defects.mjs   （服务须在 127.0.0.1:7317）
 * 原始证据：docs/verification/evidence/scan-defects.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = (process.env.AV_BASE ?? "http://127.0.0.1:7317/api").replace(/\/$/, "");
const LIB = process.env.AV_SMOKE_LIB ?? "%LIBRARY%/素材库";
const EVID = join(ROOT, "docs", "verification", "evidence");
const TMP = join(ROOT, "docs", "verification", "tmp", "repro-d1");
mkdirSync(TMP, { recursive: true });
mkdirSync(EVID, { recursive: true });
writeFileSync(join(TMP, "repro-d1-sample.zip"), Buffer.from("PK\u0003\u0004 repro"));

const req = async (p, init = {}) => {
  const r = await fetch(BASE + p, { ...init, headers: { "content-type": "application/json" } });
  const t = await r.text();
  let b; try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  return { status: r.status, body: b };
};
const post = (p, b) => req(p, { method: "POST", body: JSON.stringify(b) });
const get = (p) => req(p);
const waitJob = async (id, ms = 30000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const j = (await get("/jobs?limit=200")).body?.jobs?.find((x) => Number(x.id) === Number(id));
    if (j && ["done", "failed", "cancelled", "abandoned"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};
const snapshot = async () => (await get("/items?limit=500")).body?.items ?? [];

const out = { base: BASE, at: new Date().toISOString(), D1: {}, D2: {} };

// ---- D1: scan by rootId ----
const root = await post("/roots", { path: TMP, mode: "index_in_place" });
const rootId = root.body?.id ?? root.body?.root?.id;
out.D1.register = { status: root.status, body: root.body, rootId };
const s1 = await post("/scan", { rootId, deep: true });
out.D1.scan = { status: s1.status, body: s1.body };
if (s1.body?.jobId) {
  out.D1.job = await waitJob(Number(s1.body.jobId));
  out.D1.events = (await get(`/jobs/${s1.body.jobId}/events`)).body;
}

// ---- D2: 两次 path 扫描的 items 差异 ----
const before = await snapshot();
const scan1 = await post("/scan", { path: LIB, deep: true });
out.D2.scan1 = scan1.body;
if (scan1.body?.jobId) out.D2.job1 = (await waitJob(Number(scan1.body.jobId))) ?? "timeout";
const mid = await snapshot();
const scan2 = await post("/scan", { path: LIB, deep: true });
out.D2.scan2 = scan2.body;
if (scan2.body?.jobId) out.D2.job2 = (await waitJob(Number(scan2.body.jobId))) ?? "timeout";
const after = await snapshot();

const keys = (a) => Object.fromEntries(a.map((i) => [i.id, `${i.title} | site=${i.sourceSite} sid=${i.sourceItemId}`]));
const b = keys(before), m = keys(mid), a = keys(after);
const added1 = Object.keys(m).filter((k) => !(k in b)).map((k) => ({ id: Number(k), card: m[k] }));
const added2 = Object.keys(a).filter((k) => !(k in m)).map((k) => ({ id: Number(k), card: a[k] }));
const details = [];
for (const x of [...added1, ...added2]) {
  const d = (await get(`/items/${x.id}`)).body;
  details.push({ id: x.id, card: x.card, item: d?.item ? { uid: d.item.uid, source_site: d.item.source_site, source_item_id: d.item.source_item_id, source_url: d.item.source_url, status: d.item.status, created_at: d.item.created_at } : null, assets: (d?.assets ?? []).map((z) => z.path), images: (d?.images ?? []).length });
}
out.D2.counts = { before: before.length, afterFirst: mid.length, afterSecond: after.length, added1: added1.length, added2: added2.length };
out.D2.addedDetails = details;
out.D2.assetsBeforeAfter = { note: "见 /health.counts" };

console.log(JSON.stringify(out, null, 2));
writeFileSync(join(EVID, "scan-defects.json"), JSON.stringify(out, null, 2));
