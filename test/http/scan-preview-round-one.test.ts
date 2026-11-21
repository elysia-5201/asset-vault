import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { Repo } from "../../apps/server/src/db/repo";
import { registerRoutes, type RouteDeps } from "../../apps/server/src/http/routes";
import { normalizePath } from "../../packages/core/src/pathnorm";
import { openTempDb } from "../schema/_db";

test("扫描预览批量勾选覆盖全部页，缺失和疑似重复需要明确选择", async () => {
  const temp = openTempDb();
  const repo = new Repo(temp.db);
  const app = Fastify();
  registerRoutes(app, {
    repo, media: {} as RouteDeps["media"], booth: {} as RouteDeps["booth"], runner: {} as RouteDeps["runner"],
    log: () => {}, version: "test", dbPath: temp.file, dataDir: temp.dir,
  });
  try {
    const preview = repo.createScanPreview({ rootId: null, path: temp.dir, deep: true });
    repo.updateScanPreview(preview.id, { state: "ready" });
    const row = (name: string, change: string) => {
      const path = join(temp.dir, name + ".zip");
      return { path, path_norm: normalizePath(path), change };
    };
    const newFiles = Array.from({ length: 620 }, (_, n) => row("new-" + n, "new"));
    const missing = row("missing", "missing");
    repo.replaceScanPreviewItems(preview.id, [
      row("unchanged", "unchanged"), missing, row("similar", "duplicate_suspected"),
      row("changed", "changed"), ...newFiles,
    ]);
    const url = "/api/scan/previews/" + preview.id + "/items";
    const changes = await app.inject({ url: url + "?change=changes&limit=2" });
    assert.equal(changes.statusCode, 200, changes.body);
    assert.deepEqual(changes.json().items.map((item: { change: string }) => item.change), ["changed", "new"]);
    assert.ok(changes.json().nextCursor);

    const decide = (payload: Record<string, unknown>) => app.inject({ method: "POST", url, payload });
    const selected = await decide({ change: "changes", decision: "accept" });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().itemCounts.accepted, 621);
    assert.deepEqual(selected.json().itemCounts.byChange, { changed: 1, new: 620 });
    const confirmed = await decide({ keys: [missing.path_norm], decision: "accept" });
    assert.equal(confirmed.json().itemCounts.accepted, 622);
    const deselected = await decide({ keys: [newFiles.at(-1)!.path_norm], decision: "skip" });
    assert.equal(deselected.json().itemCounts.accepted, 621);
    assert.notEqual(deselected.json().itemCounts.selectionToken, selected.json().itemCounts.selectionToken);
    const staleApply = await app.inject({
      method: "POST", url: "/api/scan/previews/" + preview.id + "/apply",
      payload: { selectionToken: selected.json().itemCounts.selectionToken },
    });
    assert.equal(staleApply.statusCode, 409, staleApply.body);
    assert.equal(staleApply.json().error.code, "STALE_PREVIEW");
    assert.equal(repo.listScanPreviewItems(preview.id, { change: "duplicate_suspected" }).items[0].decision, "pending");
  } finally {
    await app.close();
    temp.close();
  }
});
