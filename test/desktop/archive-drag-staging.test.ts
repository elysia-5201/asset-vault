import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createArchiveDragStaging } from "../../apps/server/src/services/archive-drag";
import { buildZip } from "../../packages/core/test/content/fixtures";

let root: string;
let archive: string;
let current: { path: string; status: "present" | "missing"; container: "zip" | "file" };
before(() => {
  root = mkdtempSync(join(tmpdir(), "av-drag-test-"));
  archive = join(root, "source.zip");
  writeFileSync(archive, buildZip([
    { name: "Models/figure.fbx", data: Buffer.from("fbx-data") },
    { name: "Textures/顔.psd", data: Buffer.from("psd-data") },
    { name: "inner.zip", data: buildZip([{ name: "Textures/albedo.png", data: Buffer.from("png-data") }]) },
  ]));
  current = { path: archive, status: "present", container: "zip" };
});
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

test("stages a selected archive file with its original leaf name and opaque token", async () => {
  const staging = createArchiveDragStaging(() => current, { tempDir: root });
  try {
    const token = await staging.prepare({ assetId: 1, entryPath: "Models/figure.fbx" });
    assert.equal(typeof token, "string");
    assert.equal(token.includes("figure"), false);
    const file = staging.fileForToken(token);
    assert.ok(file);
    assert.equal(basename(file), "figure.fbx");
    assert.equal(readFileSync(file!).toString(), "fbx-data");
    assert.equal(staging.fileForToken("not-a-token"), null);
  } finally { await staging.dispose(); }
});

test("stages a selected file from one nested supported archive", async () => {
  const staging = createArchiveDragStaging(() => current, { tempDir: root });
  try {
    const token = await staging.prepare({ assetId: 1, nested: "inner.zip", entryPath: "Textures/albedo.png" });
    const file = staging.fileForToken(token);
    assert.ok(file);
    assert.equal(basename(file), "albedo.png");
    assert.equal(readFileSync(file!).toString(), "png-data");
  } finally { await staging.dispose(); }
});

test("deduplicates preparation and removes staged copies without touching the archive", async () => {
  const staging = createArchiveDragStaging(() => current, { tempDir: root });
  const ref = { assetId: 1, entryPath: "Textures/顔.psd" };
  const [first, second] = await Promise.all([staging.prepare(ref), staging.prepare(ref)]);
  assert.equal(first, second);
  const file = staging.fileForToken(first);
  assert.ok(file);
  assert.equal(basename(file), "顔.psd");
  assert.equal(readFileSync(file).toString(), "psd-data");
  await staging.dispose();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(archive), true);
});

test("rejects traversal and non-present or unsupported source assets", async () => {
  const staging = createArchiveDragStaging(() => current, { tempDir: root });
  try {
    await assert.rejects(staging.prepare({ assetId: 1, entryPath: "../escape.txt" }), /路径无效/);
    current.status = "missing";
    await assert.rejects(staging.prepare({ assetId: 1, entryPath: "Models/figure.fbx" }), /不存在或已离线/);
    current.status = "present";
    current.container = "file";
    await assert.rejects(staging.prepare({ assetId: 1, entryPath: "Models/figure.fbx" }), /仅支持/);
    current.container = "zip";
  } finally { await staging.dispose(); }
});

test("invalidates cached tokens when the source file identity changes", async () => {
  const staging = createArchiveDragStaging(() => current, { tempDir: root });
  try {
    const token = await staging.prepare({ assetId: 1, entryPath: "Models/figure.fbx" });
    writeFileSync(archive, buildZip([{ name: "Models/figure.fbx", data: Buffer.from("changed-content") }]));
    assert.equal(staging.fileForToken(token), null);
  } finally { await staging.dispose(); }
});
