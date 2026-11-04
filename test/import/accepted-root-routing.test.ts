/**
 * Final fixwave I-1: accepted-file root routing.
 *
 * The precheck protocol already returns group { rootPath, rootId }. The runner must
 * consume it instead of registering the file path itself as a library root:
 *  - valid group.rootId is reused;
 *  - null group.rootId uses group.rootPath (directory expansion keeps the outer root);
 *  - truly ungrouped files fall back to dirname(file);
 *  - legacy directory/scan keeps the directory root.
 *
 * Real TEMP files, real Repo, real runJob. No production DB/data/logs/7317.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { runJob } from "../../apps/server/src/jobs/runner";
import { precheckPaths } from "../../apps/server/src/services/precheck";

function deps(repo: Repo) {
  return { repo, media: {} as any, booth: {} as any, log: () => {} };
}

function roots(db: any): any[] {
  return db.prepare("SELECT id, path, path_norm FROM library_roots ORDER BY id").all() as any[];
}

function assetRoot(db: any, file: string): any {
  return db.prepare("SELECT root_id FROM assets WHERE path_norm = ?").get(normalizePath(file)) as any;
}

function expectedOf(file: string) {
  const st = statSync(file);
  return { size: st.size, mtime: st.mtime.toISOString() };
}

test("accepted file reuses precheck group.rootId and adds no file-path root", async () => {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const rootDir = mkdtempSync(join(tmpdir(), "av-root-existing-"));
  try {
    const file = join(rootDir, "a.zip");
    writeFileSync(file, "A");
    const rootId = addRoot(t.db, normalizePath(rootDir), rootDir);
    const pre = await precheckPaths({ repo }, { paths: [file] });
    assert.equal(pre.results.length, 1);
    const r = pre.results[0];
    assert.equal(r.group.rootId, rootId);
    assert.equal(r.group.rootPath, rootDir);

    const before = roots(t.db).length;
    const job = repo.createJob("import_file", null, {
      path: r.path,
      expected: { size: r.size!, mtime: r.mtime! },
      group: r.group,
    }, 5);
    await runJob(deps(repo), job.id);

    assert.equal(repo.getJob(job.id)!.state, "done");
    assert.equal(roots(t.db).length, before, "existing root must be reused, not duplicated");
    assert.equal(assetRoot(t.db, file).root_id, rootId);
    assert.equal(roots(t.db).some((x) => x.path_norm === normalizePath(file)), false, "file path must not become a root");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    t.close();
  }
});

test("nested accepted files with null group.rootId share one directory root", async () => {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const groupDir = mkdtempSync(join(tmpdir(), "av-root-group-"));
  try {
    mkdirSync(join(groupDir, "sub"));
    const f1 = join(groupDir, "a.zip");
    const f2 = join(groupDir, "sub", "b.zip");
    writeFileSync(f1, "A");
    writeFileSync(f2, "B");

    const pre = await precheckPaths({ repo }, { paths: [groupDir] });
    assert.equal(pre.results.length, 2);
    for (const r of pre.results) {
      assert.equal(r.group.rootPath, groupDir);
      assert.equal(r.group.rootId, null);
    }

    const before = roots(t.db).length;
    for (const r of pre.results) {
      const job = repo.createJob("import_file", null, {
        path: r.path,
        expected: { size: r.size!, mtime: r.mtime! },
        group: r.group,
      }, 5);
      await runJob(deps(repo), job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
    }

    const after = roots(t.db);
    assert.equal(after.length, before + 1, "one group directory root, not one root per file");
    const groupRoot = after.find((x) => x.path_norm === normalizePath(groupDir));
    assert.ok(groupRoot, "group directory root must exist");
    assert.equal(assetRoot(t.db, f1).root_id, groupRoot.id);
    assert.equal(assetRoot(t.db, f2).root_id, groupRoot.id);
    assert.equal(after.some((x) => x.path_norm === normalizePath(f1) || x.path_norm === normalizePath(f2)), false);
  } finally {
    rmSync(groupDir, { recursive: true, force: true });
    t.close();
  }
});

test("accepted files without group fall back to dirname, not file-path roots", async () => {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dirA = mkdtempSync(join(tmpdir(), "av-root-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "av-root-b-"));
  try {
    const f1 = join(dirA, "a.zip");
    const f2 = join(dirB, "b.zip");
    writeFileSync(f1, "A");
    writeFileSync(f2, "B");

    const before = roots(t.db).length;
    for (const f of [f1, f2]) {
      const job = repo.createJob("import_file", null, { path: f, expected: expectedOf(f) }, 5);
      await runJob(deps(repo), job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
    }

    const after = roots(t.db);
    assert.equal(after.length, before + 2);
    const r1 = after.find((x) => x.path_norm === normalizePath(dirA));
    const r2 = after.find((x) => x.path_norm === normalizePath(dirB));
    assert.ok(r1, "dirname root for first file");
    assert.ok(r2, "dirname root for second file");
    assert.equal(assetRoot(t.db, f1).root_id, r1.id);
    assert.equal(assetRoot(t.db, f2).root_id, r2.id);
    assert.equal(after.some((x) => x.path_norm === normalizePath(f1) || x.path_norm === normalizePath(f2)), false);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    t.close();
  }
});

test("legacy directory keeps directory root; legacy single file uses dirname", async () => {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-root-legacy-"));
  try {
    const file = join(dir, "a.zip");
    writeFileSync(file, "A");
    const before = roots(t.db).length;

    const dirJob = repo.createJob("import_file", null, { path: dir, legacy: true }, 5);
    await runJob(deps(repo), dirJob.id);
    assert.equal(repo.getJob(dirJob.id)!.state, "done");
    const afterDir = roots(t.db);
    assert.equal(afterDir.length, before + 1);
    const dirRoot = afterDir.find((x) => x.path_norm === normalizePath(dir));
    assert.ok(dirRoot, "legacy directory root");
    assert.equal(assetRoot(t.db, file).root_id, dirRoot.id);
    assert.equal(afterDir.some((x) => x.path_norm === normalizePath(file)), false);

    const file2 = join(dir, "b.zip");
    writeFileSync(file2, "B");
    const fileJob = repo.createJob("import_file", null, { path: file2, legacy: true }, 5);
    await runJob(deps(repo), fileJob.id);
    assert.equal(repo.getJob(fileJob.id)!.state, "done");
    const afterFile = roots(t.db);
    assert.equal(afterFile.length, before + 1, "legacy single file reuses the dirname root");
    assert.equal(assetRoot(t.db, file2).root_id, dirRoot.id);
    assert.equal(afterFile.some((x) => x.path_norm === normalizePath(file2)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    t.close();
  }
});
