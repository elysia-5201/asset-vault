import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes, type RouteDeps } from "../../apps/server/src/http/routes";
import { createImportPlan, precheckImportPlan } from "../../apps/server/src/services/structure";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { addAsset, addItem, addRoot, openTempDb, type TempDb } from "../schema/_db";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let fixtureNo = 0;

function setup(t: TempDb) {
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerRoutes(app as any, {
    repo, media: {} as any, booth: {} as any, runner: {} as any, log: () => {},
    version: "test", dbPath: t.file, dataDir: t.dir, pipeline: null,
  } as any);
  return { repo, app };
}

function fixture(t: TempDb, opts: { sourceHash?: string | null; sourceStatus?: string; sourceItemId?: number; candidateItemId?: number } = {}) {
  const { db } = t;
  const sourceItemId = opts.sourceItemId ?? addItem(db, { title: "Source card", notes: "keep source card" });
  const candidateItemId = opts.candidateItemId ?? sourceItemId;
  const fixtureRoot = join(t.dir, "fixture-" + (++fixtureNo));
  const sourceRootPath = join(fixtureRoot, "source-root");
  const candidateRootPath = join(fixtureRoot, "candidate-root");
  mkdirSync(sourceRootPath, { recursive: true });
  mkdirSync(candidateRootPath, { recursive: true });
  const sourcePath = join(sourceRootPath, "old", "package.zip");
  const candidatePath = join(candidateRootPath, "new", "package.zip");
  mkdirSync(join(sourcePath, ".."), { recursive: true });
  mkdirSync(join(candidatePath, ".."), { recursive: true });
  const bytes = Buffer.from("same indexed archive bytes");
  writeFileSync(candidatePath, bytes);
  const sourceRootId = addRoot(db, normalizePath(sourceRootPath), sourceRootPath);
  const candidateRootId = addRoot(db, normalizePath(candidateRootPath), candidateRootPath);
  const sourceId = addAsset(db, sourceItemId, sourceRootId, normalizePath(sourcePath), {
    path: sourcePath, size: bytes.length, mtime: "2026-01-01T00:00:00.000Z",
    sha256: opts.sourceHash === undefined ? hash(bytes) : opts.sourceHash,
    sha256_state: opts.sourceHash === null ? "pending" : "ok",
    status: opts.sourceStatus ?? "missing", index_state: "done", indexed_at: "2026-01-02T00:00:00.000Z",
  });
  const candidateId = addAsset(db, candidateItemId, candidateRootId, normalizePath(candidatePath), {
    path: candidatePath, size: bytes.length, mtime: "2026-01-01T00:00:00.000Z",
    sha256: hash(bytes), sha256_state: "ok", status: "present", index_state: "done",
    indexed_at: "2026-01-02T00:00:00.000Z",
  });
  return { repo: new Repo(db), sourceItemId, candidateItemId, sourceRootPath, candidateRootPath, sourcePath, candidatePath, bytes, sourceRootId, candidateRootId, sourceId, candidateId };
}

const getCandidates = (app: any, id: number) => app.inject({ method: "GET", url: `/api/assets/${id}/relocation-candidates` });
const relocate = (app: any, x: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) => app.inject({
  method: "POST", url: `/api/assets/${x.sourceId}/relocate`,
  payload: {
    candidateId: x.candidateId, expectedPath: x.sourcePath, expectedItemId: x.sourceItemId,
    expectedCandidatePath: x.candidatePath, expectedCandidateItemId: x.candidateItemId, ...over,
  },
});
const removeMissing = (app: any, x: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) => app.inject({
  method: "POST", url: `/api/assets/${x.sourceId}/remove-missing`,
  payload: { expectedPath: x.sourcePath, expectedItemId: x.sourceItemId, ...over },
});

test("relocation preserves source identity and card; retires duplicate and frees candidate path", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t);
    const sourceCard = t.db.prepare("SELECT title, notes, status FROM items WHERE id=?").get(x.sourceItemId);
    const candidates = await getCandidates(app, x.sourceId);
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.deepEqual(candidates.json().candidates.map((c: any) => c.assetId), [x.candidateId]);

    const r = await relocate(app, x);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true });
    const source = repo.getAsset(x.sourceId)!;
    assert.equal(source.id, x.sourceId);
    assert.equal(source.path, x.candidatePath);
    assert.equal(source.item_id, x.sourceItemId);
    assert.equal(source.status, "present");
    assert.equal((t.db.prepare("SELECT index_state FROM assets WHERE id=?").get(x.sourceId) as any).index_state, "done",
      "same-content indexed metadata is reused without forced reindex");
    assert.equal(repo.getAsset(x.candidateId)?.status, "trashed");
    assert.equal(repo.getAssetByPathNorm(normalizePath(x.candidatePath))?.id, x.sourceId);
    assert.deepEqual(t.db.prepare("SELECT title, notes, status FROM items WHERE id=?").get(x.sourceItemId), sourceCard);
    assert.equal(existsSync(x.candidatePath), true, "relocation changes database association, not the user's file");
  } finally { await app.close(); t.close(); }
});

test("relocation refreshes only verified unit fingerprints: old plan stays stale, new plan is ready", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t);
    const oldName = basename(x.sourcePath);
    writeFileSync(x.sourcePath, x.bytes);
    utimesSync(x.sourcePath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    const oldStat = statSync(x.sourcePath);
    t.db.prepare("UPDATE assets SET kind='unitypackage', container='unitypackage', status='present', size=?, mtime=?, sha256=?, sha256_state='ok' WHERE id=?")
      .run(x.bytes.length, oldStat.mtime.toISOString(), hash(x.bytes), x.sourceId);
    t.db.prepare("UPDATE assets SET kind='unitypackage', container='unitypackage' WHERE id=?").run(x.candidateId);
    const oldFingerprint = `${x.bytes.length}:${oldStat.mtime.toISOString()}:${hash(x.bytes).slice(0, 8)}`;
    const insertUnit = t.db.prepare(`INSERT INTO asset_units(asset_id,item_id,rel_path,format,kind,name,size,fingerprint,policy,importable,parse_state,created_at,updated_at)
      VALUES (?,?,?,'unitypackage','unitypackage',?,?,?,'single_unitypackage',1,'ok','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    const directUnitId = Number(insertUnit.run(x.sourceId, x.sourceItemId, oldName, oldName, x.bytes.length, oldFingerprint).lastInsertRowid);
    const nestedRelPath = "outer.zip::nested.unitypackage";
    const nestedUnitId = Number(insertUnit.run(x.sourceId, x.sourceItemId, nestedRelPath, "nested.unitypackage", x.bytes.length, oldFingerprint).lastInsertRowid);
    const containerUnitId = Number(insertUnit.run(x.sourceId, x.sourceItemId, "", oldName, x.bytes.length, oldFingerprint).lastInsertRowid);
    const staleUnitId = Number(insertUnit.run(x.sourceId, x.sourceItemId, "stale-evidence", "stale-evidence", x.bytes.length, "legacy-unknown").lastInsertRowid);

    const oldPlan = await createImportPlan(repo, { unitIds: [directUnitId], projectPath: t.dir });
    assert.equal(oldPlan.plan.status, "ready");
    const oldSnapshot = oldPlan.plan.source_snapshot_json;
    const oldPlanItem = t.db.prepare("SELECT fingerprint FROM import_plan_items WHERE plan_id=? AND unit_id=?").get(oldPlan.plan.id, directUnitId) as any;

    unlinkSync(x.sourcePath);
    t.db.prepare("UPDATE assets SET status='missing' WHERE id=?").run(x.sourceId);
    const moved = await relocate(app, x);
    assert.equal(moved.statusCode, 200, moved.body);

    const direct = t.db.prepare("SELECT id,rel_path,name,fingerprint FROM asset_units WHERE id=?").get(directUnitId) as any;
    assert.equal(direct.id, directUnitId);
    assert.equal(direct.rel_path, basename(x.candidatePath), "direct unitypackage unit name follows the relocated filename");
    assert.equal(direct.name, basename(x.candidatePath));
    const containerUnit = t.db.prepare("SELECT id,rel_path,name,fingerprint FROM asset_units WHERE id=?").get(containerUnitId) as any;
    assert.equal(containerUnit.rel_path, "", "whole-container unit keeps its stable empty rel_path");
    assert.equal(containerUnit.name, basename(x.candidatePath));
    const nested = t.db.prepare("SELECT id,rel_path,name,fingerprint FROM asset_units WHERE id=?").get(nestedUnitId) as any;
    assert.equal(nested.id, nestedUnitId);
    assert.equal(nested.rel_path, nestedRelPath, "nested package path remains unchanged");
    assert.equal(nested.fingerprint, direct.fingerprint, "verified nested evidence gets the new outer-file fingerprint");
    assert.equal((t.db.prepare("SELECT fingerprint FROM asset_units WHERE id=?").get(staleUnitId) as any).fingerprint, "legacy-unknown",
      "unknown old evidence is not upgraded");
    assert.equal((t.db.prepare("SELECT source_snapshot_json FROM import_plans WHERE id=?").get(oldPlan.plan.id) as any).source_snapshot_json, oldSnapshot);
    assert.equal((t.db.prepare("SELECT fingerprint FROM import_plan_items WHERE plan_id=? AND unit_id=?").get(oldPlan.plan.id, directUnitId) as any).fingerprint,
      oldPlanItem.fingerprint, "historical plan item fingerprint is immutable");
    assert.throws(() => precheckImportPlan(repo, oldPlan.plan.id), (e: any) => e.code === "FINGERPRINT_CHANGED");

    const newPlan = await createImportPlan(repo, { unitIds: [directUnitId], projectPath: t.dir });
    assert.equal(newPlan.plan.status, "ready");
    assert.doesNotThrow(() => precheckImportPlan(repo, newPlan.plan.id));
  } finally { await app.close(); t.close(); }
});

test("cross-item relocation transfers the source asset explicitly and keeps both cards", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const sourceItemId = addItem(t.db, { title: "Original card", notes: "retained" });
    const candidateItemId = addItem(t.db, { title: "Candidate card", notes: "also retained" });
    const x = fixture(t, { sourceItemId, candidateItemId });
    const r = await relocate(app, x);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(repo.getAsset(x.sourceId)?.item_id, sourceItemId, "source asset keeps its original owner");
    assert.equal(repo.getAsset(x.sourceId)?.path, x.candidatePath);
    assert.equal(repo.getAsset(x.candidateId)?.status, "trashed");
    assert.deepEqual(t.db.prepare("SELECT id, title, notes FROM items WHERE id IN (?,?) ORDER BY id").all(sourceItemId, candidateItemId), [
      { id: sourceItemId, title: "Original card", notes: "retained" },
      { id: candidateItemId, title: "Candidate card", notes: "also retained" },
    ]);
  } finally { await app.close(); t.close(); }
});

test("relocation keeps project import history and the candidate file available for rescan", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t);
    const projectId = Number(t.db.prepare("INSERT INTO projects(name,path,path_norm,created_at) VALUES (?,?,?,?)")
      .run("Project", join(t.dir, "project"), normalizePath(join(t.dir, "project")), "2026-01-01T00:00:00.000Z").lastInsertRowid);
    repo.addProjectImport(projectId, x.candidateItemId, x.candidateId, "historical import");
    const before = t.db.prepare("SELECT * FROM project_imports WHERE project_id=?").get(projectId);
    const r = await relocate(app, x);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(t.db.prepare("SELECT * FROM project_imports WHERE project_id=?").get(projectId), before,
      "relocation must not delete or rewrite an import ledger row");
    assert.equal(existsSync(x.candidatePath), true);
    assert.equal(repo.getAssetByPathNorm(normalizePath(x.candidatePath))?.id, x.sourceId,
      "a later scan/upsert of the live path must find the preserved source ID");
  } finally { await app.close(); t.close(); }
});

test("candidate with a version link cannot be retired", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t);
    const otherId = addAsset(t.db, x.candidateItemId, x.candidateRootId, normalizePath(join(t.dir, "candidate-root", "other.zip")));
    const [a, b] = [Math.min(x.candidateId, otherId), Math.max(x.candidateId, otherId)];
    t.db.prepare(`INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,created_at,updated_at)
      VALUES (?,?,?,'same','manual','confirmed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run(x.candidateItemId, a, b);
    const beforeSource = repo.getAsset(x.sourceId);
    const r = await relocate(app, x);
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(repo.getAsset(x.sourceId), beforeSource);
    assert.equal(repo.getAsset(x.candidateId)?.status, "present");
    assert.equal(repo.getAssetByPathNorm(normalizePath(x.candidatePath))?.id, x.candidateId);
  } finally { await app.close(); t.close(); }
});

test("stale source or candidate snapshots are rejected without writes", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t);
    const before = [repo.getAsset(x.sourceId), repo.getAsset(x.candidateId)];
    assert.equal((await relocate(app, x, { expectedPath: x.sourcePath + ".stale" })).statusCode, 409);
    assert.equal((await relocate(app, x, { expectedCandidatePath: x.candidatePath + ".stale" })).statusCode, 409);
    assert.equal((await relocate(app, x, { expectedCandidateItemId: x.sourceItemId + 500 })).statusCode, 409);
    assert.deepEqual([repo.getAsset(x.sourceId), repo.getAsset(x.candidateId)], before);
  } finally { await app.close(); t.close(); }
});

test("a same-size candidate that changes after selection is rejected by its live hash", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  try {
    const x = fixture(t);
    const candidates = await getCandidates(app, x.sourceId);
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.deepEqual(candidates.json().candidates.map((c: any) => c.assetId), [x.candidateId],
      "candidate listing uses stored indexed metadata; live hash is verified before mutation");
    writeFileSync(x.candidatePath, Buffer.alloc(x.bytes.length, 0x41));
    assert.equal((await relocate(app, x)).statusCode, 409);
  } finally { await app.close(); t.close(); }
});

test("reappeared source or unavailable source root blocks both relocation and removal", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const reappeared = fixture(t);
    mkdirSync(join(reappeared.sourcePath, ".."), { recursive: true });
    writeFileSync(reappeared.sourcePath, reappeared.bytes);
    assert.equal((await relocate(app, reappeared)).statusCode, 409);
    assert.equal((await removeMissing(app, reappeared)).statusCode, 409);
    assert.equal(repo.getAsset(reappeared.sourceId)?.status, "missing");

    const offline = fixture(t);
    rmSync(offline.sourceRootPath, { recursive: true, force: true });
    assert.equal((await relocate(app, offline)).statusCode, 409);
    assert.equal((await removeMissing(app, offline)).statusCode, 409);
    assert.equal(repo.getAsset(offline.sourceId)?.status, "missing");
  } finally { await app.close(); t.close(); }
});

test("source without a trusted hash has no candidates, but explicit missing removal still works", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  try {
    const x = fixture(t, { sourceHash: null });
    const candidates = await getCandidates(app, x.sourceId);
    assert.equal(candidates.statusCode, 200, candidates.body);
    assert.deepEqual(candidates.json().candidates, []);
    const r = await removeMissing(app, x);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true });
    assert.equal(repo.getAsset(x.sourceId)?.status, "trashed");
    assert.notEqual(repo.getAsset(x.sourceId)?.path_norm, normalizePath(x.sourcePath), "removal releases the unique path key");
    assert.equal(repo.getAsset(x.candidateId)?.status, "present");
    assert.equal(existsSync(x.candidatePath), true);
  } finally { await app.close(); t.close(); }
});

test("relocation and removal validate IDs and request shapes", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  try {
    const x = fixture(t);
    assert.equal((await getCandidates(app, 0)).statusCode, 400);
    assert.equal((await getCandidates(app, 999999)).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/assets/${x.sourceId}/relocate`, payload: { candidateId: "bad" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/assets/${x.sourceId}/remove-missing`, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/assets/999999/remove-missing", payload: { expectedPath: x.sourcePath, expectedItemId: x.sourceItemId } })).statusCode, 404);
  } finally { await app.close(); t.close(); }
});
