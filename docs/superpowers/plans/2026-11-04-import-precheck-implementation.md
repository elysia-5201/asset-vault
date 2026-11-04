# 导入前预检与版本关系实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在登记前给出只读预检（exact / 同商品 / 版本候选 / 配套 / 路径冲突），把“接受列表 + expected”变成导入契约，并让下载走 stage→commit 两阶段与版本关系持久化。

**Architecture:** 预检是纯读服务（`services/precheck.ts`）；导入只接受显式文件列表（`services/import-files.ts` + runner 单文件门）；版本关系落 `asset_version_links`（`db/version-links.ts`）；下载用 HMAC opaque token + 回执表（`services/stage-token.ts`、`services/stage-commit.ts`）。路由各自 `registerXxxRoutes`，由总入口接线。

**Tech Stack:** TypeScript 5.9、Fastify 5、better-sqlite3 13、`node:crypto`、`node:test` + tsx。

**Spec:** `docs/superpowers/specs/2026-11-04-import-precheck-design.md`（revision-4）。

## Global Constraints

- 预检只读：不写 items/assets/asset_signatures/scan_preview_*，不建 job，不调用 `computeSignature`/`fingerprintOf`/`findDuplicatesForItem`/`mergeItems`。
- `exact` 必须同时满足：入参现算 + 候选 `sha256_state='ok'` + stat size/mtime 一致 + 候选本次重算相等；预算不足 → `existing_hash_unverified`。
- `files` 形状执行阶段不递归；每项必须带 `expected`；`expected.sha256` 存在即强制重算。
- commit：token 校验/重算在事务外；`BEGIN IMMEDIATE` 后先按 nonce 重查回执，再重验归属，再 NULL 指针 INSERT，再登记，再 UPDATE 指针；事务内无 `await`。
- 不新增 `AppErrorCode`；子码放 `details.code`。不新增 npm 依赖。
- 测试只连临时 DB/临时文件；不碰 7317、`data/`、真实素材。
- 本计划不写 `apps/server/src/http/routes.ts` / `apps/server/src/db/repo.ts`；共享文件由总入口 P1-T2/P1-T3/P1-T5 串行交接。任务期不 `git add`/`commit`，只记录 diff/hash 交接。

## Review Focus

1. 保持 mtime 的改写（`touch -r`）→ 不 exact，`weak.reason="existing_hash_mismatch"`（Task 1）。
2. 预算耗尽 → `existing_hash_unverified`，不得用名称/尺寸冒充 exact（Task 1）。
3. `files` 里目录或缺 `expected` → 400，且不建 job（Task 2）。
4. stage 后路径被另一 item 占用 → commit 409 `PATH_OWNED_BY_OTHER_ITEM`，owner 不变（Task 4）。
5. 并发同 token → 一个成功、另一个事务内重查返回 200 指针，不重复建行（Task 4）。

---

### Task 1: 只读预检服务

**Files:**
- Create: `apps/server/src/services/precheck.ts`
- Test: `test/import/precheck.test.ts`

**Interfaces:**
- Produces: `precheckPaths(deps: { repo: Repo; log?: (m: string) => void }, input: PrecheckInput, signal?: AbortSignal): Promise<PrecheckResponse>`；`PrecheckInput { paths: string[]; source?: { site?: string; itemId?: string; title?: string }; budget?: { maxBytes?: number; maxMs?: number } }`；`PrecheckResult.match` 六字段（`exact|sameProduct|version|companion|weak|pathCollision`）与 `summary` 优先级 `exact > version-candidate > companion-candidate > same-product > pathCollision > weak > unknown > none`。
- Consumes: `repo.getAssetByPathNorm`、`repo.connection`、`sha256FileChunked`、`identifyFromNames`、`parseVersionKey`、`parseVersion`、`compareVersions`、`walkCandidates`、`normalizePath`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { sha256Buffer } from "../../packages/core/src/hash";
import { precheckPaths } from "../../apps/server/src/services/precheck";

test("exact 只由 stat 一致 + 本次重算相等得出", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "AAA");
  const st = statSync(f);
  const itemId = addItem(t.db, { title: "A" });
  const assetId = addAsset(t.db, itemId, rootId, f, { path: f, path_norm: f, size: 3, mtime: st.mtime.toISOString(), sha256: sha256Buffer("AAA"), sha256_state: "ok" });
  const before = { items: count(t.db, "items"), assets: count(t.db, "assets") };
  const r = await precheckPaths({ repo }, { paths: [f] });
  assert.equal(r.results[0].match.exact?.assetId, assetId);
  assert.equal(r.results[0].match.exact?.rehashVerified, true);
  assert.equal(r.results[0].summary, "exact");
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  const src = readFileSync(new URL("../../apps/server/src/services/precheck.ts", import.meta.url), "utf8");
  assert.ok(!/computeSignature|fingerprintOf|findDuplicatesForItem|mergeItems/.test(src));
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("陈旧/保持时间戳/预算不足都不 exact", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "AAA");
  const st = statSync(f);
  const itemId = addItem(t.db, { title: "B" });
  addAsset(t.db, itemId, rootId, f, { path: f, path_norm: f, size: 3, mtime: st.mtime.toISOString(), sha256: sha256Buffer("AAA"), sha256_state: "ok" });
  utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  assert.equal((await precheckPaths({ repo }, { paths: [f] })).results[0].match.weak?.reason, "existing_hash_stale");
  writeFileSync(f, "BBB"); utimesSync(f, st.atime, st.mtime);
  assert.equal((await precheckPaths({ repo }, { paths: [f] })).results[0].match.weak?.reason, "existing_hash_mismatch");
  assert.equal((await precheckPaths({ repo }, { paths: [f], budget: { maxBytes: 4 } })).results[0].match.weak?.reason, "existing_hash_unverified");
  const ac = new AbortController(); ac.abort();
  assert.equal((await precheckPaths({ repo }, { paths: [f] }, ac.signal)).results[0].hash.state, "unknown");
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("同商品版本候选、不可解析、路径冲突", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-pre3-"));
  const old = join(dir, "6115428_v1.2.zip"); writeFileSync(old, "OLD");
  const itemId = addItem(t.db, { title: "6115428", source_site: "booth", source_item_id: "6115428" });
  addAsset(t.db, itemId, rootId, old, { path: old, path_norm: old, size: 3, mtime: statSync(old).mtime.toISOString() });
  const inc = join(dir, "6115428_v1.3.zip"); writeFileSync(inc, "NEW");
  const r = await precheckPaths({ repo }, { paths: [inc] });
  assert.equal(r.results[0].match.sameProduct?.itemId, itemId);
  assert.equal(r.results[0].match.version?.relation, "newer");
  assert.equal(r.results[0].match.version?.proven, false);
  const odd = join(dir, "6115428_2025.zip"); writeFileSync(odd, "X");
  assert.equal((await precheckPaths({ repo }, { paths: [odd] })).results[0].match.version?.relation, "unknown");
  const owned = join(dir, "owned.zip"); writeFileSync(owned, "OWN");
  addAsset(t.db, itemId, rootId, owned, { path: owned, path_norm: owned, size: 3 });
  const c = await precheckPaths({ repo }, { paths: [owned] });
  assert.equal(c.results[0].match.pathCollision?.sameItem, true);
  rmSync(dir, { recursive: true, force: true }); t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/import/precheck.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

预算默认 4 GiB / 20 s / 单文件 2 GiB；`paths` 1..200、绝对路径、展开上限 500（超出 `truncated=true`）。exact 判定严格按 §3.1 四条；候选重算计入同一预算。`summary` 按固定优先级派生。单文件失败只写该条 `hash.state="unknown"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/import/precheck.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/services/precheck.ts test/import/precheck.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/services/precheck.ts test/import/precheck.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T1.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 2: 接受列表导入与 expected 重验

**Files:**
- Create: `apps/server/src/services/import-files.ts`
- Modify: `apps/server/src/jobs/runner.ts`（`isFile` 分支，登记前门）
- Test: `test/import/accepted-files.test.ts`

**Interfaces:**
- Produces: `AcceptedFile { path: string; expected: { size: number; mtime: string; sha256?: string }; group?: { rootPath: string; rootId: number | null } }`；`createImportPathJobs(deps: { repo: Repo }, body: { paths?: string[]; files?: AcceptedFile[] }): { jobIds: number[]; duplicates: string[]; legacy: boolean }`；`verifyAcceptedFile(deps: { repo: Repo }, f: AcceptedFile): Promise<{ ok: true; verified: "sha256" | "metadata" } | { ok: false; reason: "PRECHECK_STALE" | "PATH_OWNED_BY_OTHER_ITEM"; details?: { itemId: number; assetId: number } }>`；`verifyExpectedOrThrow(deps, itemId, path, expected?): Promise<void>`；`shouldSkipForOwnerConflict(repo, itemId, pathNorm): { skip: false } | { skip: true; itemId: number; assetId: number }`。
- Consumes: Task 1 的 `normalizePath`/`sha256FileChunked`；`repo.getAssetByPathNorm`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { createImportPathJobs, verifyAcceptedFile, verifyExpectedOrThrow, shouldSkipForOwnerConflict } from "../../apps/server/src/services/import-files";

test("files 形状：目录/缺 expected 拒绝，重复路径去重", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-acc-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "A");
  const exp = { size: 1, mtime: statSync(f).mtime.toISOString() };
  assert.throws(() => createImportPathJobs({ repo }, { files: [{ path: dir, expected: exp }] }), (e: any) => e.details?.code === "DIRECTORY_NOT_ALLOWED_WITH_FILES");
  assert.throws(() => createImportPathJobs({ repo }, { files: [{ path: f } as any] }), (e: any) => e.details?.code === "EXPECTED_REQUIRED");
  const r = createImportPathJobs({ repo }, { files: [{ path: f, expected: exp }, { path: f, expected: exp }] });
  assert.equal(r.jobIds.length, 1); assert.deepEqual(r.duplicates, [f]); assert.equal(r.legacy, false);
  assert.deepEqual(JSON.parse(repo.getJob(r.jobIds[0])!.payload!).expected, exp);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("expected 不匹配 → PRECHECK_STALE，不登记；路径占用 → 409", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-acc2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "BB");
  const exp = { size: 2, mtime: statSync(f).mtime.toISOString(), sha256: "0".repeat(64) };
  const bad = await verifyAcceptedFile({ repo }, { path: f, expected: exp });
  assert.deepEqual(bad, { ok: false, reason: "PRECHECK_STALE" });
  const good = await verifyAcceptedFile({ repo }, { path: f, expected: { size: 2, mtime: exp.mtime } });
  assert.deepEqual(good, { ok: true, verified: "metadata" });
  const owner = addItem(t.db, { title: "owner" }); const other = addItem(t.db, { title: "other" });
  const ownedId = addAsset(t.db, owner, rootId, f, { path: f, path_norm: f, size: 2 });
  await assert.rejects(() => verifyExpectedOrThrow({ repo }, other, f, { size: 2, mtime: exp.mtime }), (e: any) => e.code === "CONFLICT" && e.details?.code === "PATH_OWNED_BY_OTHER_ITEM");
  assert.deepEqual(shouldSkipForOwnerConflict(repo, other, f), { skip: true, itemId: owner, assetId: ownedId });
  assert.equal(count(t.db, "assets"), 1);
  rmSync(dir, { recursive: true, force: true }); t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/import/accepted-files.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`files` 存在时不递归；按 `normalizePath` 去重保首个；每文件一个 `import_file` job，payload `{path, expected, group}`。runner 的 `isFile` 分支在 `registerBatch` 前调用 `verifyAcceptedFile`，失败则 `logJobEvent(..., "precheck_stale", ...)` 并抛 `PRECHECK_STALE`，不建 item/asset。`registerBatch` 在 `createItem` 前逐文件调 `shouldSkipForOwnerConflict`；冲突 → 跳过该文件 + `logJobEvent(..., "asset_owner_conflict_skipped", ...)`，整批不失败、不建空 item。`paths` 旧形状原样保留并标 `legacy:true`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/import/accepted-files.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/server/src/jobs/runner.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T2.patch
cp --parents apps/server/src/services/import-files.ts test/import/accepted-files.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/services/import-files.ts apps/server/src/jobs/runner.ts test/import/accepted-files.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T2.sha256
git diff --cached --stat   # 必须为空
```
Expected: diff/备份/hash 落盘；索引/HEAD 未变。

---

### Task 3: 版本关系持久化与端点

**Files:**
- Create: `apps/server/src/db/version-links.ts`
- Create: `apps/server/src/http/routes/import-precheck.ts`
- Test: `test/db/version-links.test.ts`

**Interfaces:**
- Produces: `listVersionLinks(repo, itemId, q): { total: number; links: VersionLinkRow[] }`；`createVersionLink(repo, itemId, input): VersionLinkRow`；`patchVersionLink(repo, itemId, linkId, input): VersionLinkRow`；`deleteVersionLink(repo, itemId, linkId): { deleted: boolean }`；`registerImportPrecheckRoutes(app, deps): void`（注册 `POST /api/import/precheck`、`GET/POST/PATCH/DELETE /api/items/:id/version-links`、`POST /api/import/download/commit`）。
- Consumes: Task 1 的 `precheckPaths`；Task 4 的 `commitStageToken`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { createVersionLink, patchVersionLink, listVersionLinks } from "../../apps/server/src/db/version-links";

test("建关系规范化 a<b；CAS 转移；同状态 no-op", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, itemId, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, itemId, rootId, "/lib/2.zip");
  const link = createVersionLink(repo, itemId, { assetAId: a2, assetBId: a1, relation: "a_newer" });
  assert.equal(link.assetAId, a1); assert.equal(link.assetBId, a2); assert.equal(link.relation, "b_newer");
  assert.equal(link.state, "candidate"); assert.equal(link.version, 1);
  const confirmed = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 1 });
  assert.equal(confirmed.state, "confirmed"); assert.equal(confirmed.version, 2); assert.ok(confirmed.decidedAt);
  const noop = patchVersionLink(repo, itemId, link.id, { state: "confirmed", expectedVersion: 2 });
  assert.equal(noop.version, 2);
  assert.throws(() => patchVersionLink(repo, itemId, link.id, { state: "revoked", expectedVersion: 1 }), (e: any) => e.code === "CONFLICT");
  assert.equal(listVersionLinks(repo, itemId, {}).total, 1);
  assert.equal(count(t.db, "audit_log", "action=?", "version_link.confirm"), 1);
  t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/db/version-links.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

POST 按 id 升序规范并交换 `a_newer`/`b_newer`；重复对 409。PATCH 只允许 `candidate|confirmed|revoked` 与四个 relation；同状态 no-op（不递增、不写审计）；真实转移 `version+1` + `decided_at` + `audit_log` 同事务。跨 item 资产 → 400。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/db/version-links.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
cp --parents apps/server/src/db/version-links.ts apps/server/src/http/routes/import-precheck.ts test/db/version-links.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/db/version-links.ts apps/server/src/http/routes/import-precheck.ts test/db/version-links.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T3.sha256
git diff --cached --stat   # 必须为空
```
Expected: 备份/hash 落盘；索引/HEAD 未变。

---

### Task 4: stage token 与原子 commit

**Files:**
- Create: `apps/server/src/services/stage-token.ts`
- Create: `apps/server/src/services/stage-commit.ts`
- Modify: `apps/server/src/services/booth.ts`（新增 `attachBoothMetadata`，只附加）
- Test: `test/import/stage-commit.test.ts`

**Interfaces:**
- Produces: `createStageTokenCodec(secret: Buffer, epoch: string): { issue(p: Omit<StageTokenPayload, "v" | "ep">): string; verify(token: string): StageTokenPayload }`；`lookupReceipt(repo, nonce, tokenHash): { kind: "none" } | { kind: "replay"; decision: "import" | "skip"; itemId: number | null; assetId: number | null } | { kind: "conflict" }`；`commitStageToken(deps, token, decision): Promise<CommitResult>`；`commitStageTokenInTx(deps, payload, tokenHash, decision): CommitResult`；`stageDownload(deps, body): Promise<{ staged: true; stageToken: string; bytes: number; fileName: string; precheck: PrecheckResponse; meta?: unknown }>`；`CommitDeps.attach?: (repo, media, booth, itemId, meta) => Promise<void>`（默认 `attachBoothMetadata`，测试可注入）。
- Consumes: Task 1 的 `precheckPaths`；Task 2 的 `verifyAcceptedFile`；`repo.connection`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { sha256Text } from "../../apps/server/src/util";
import { createStageTokenCodec } from "../../apps/server/src/services/stage-token";
import { commitStageToken, commitStageTokenInTx, lookupReceipt, stageDownload } from "../../apps/server/src/services/stage-commit";

test("commit 原子、重放 200、异 token 409、同商品复用、NULL 指针 410、重启 410", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-stage-"));
  const f = join(dir, "a.zip"); writeFileSync(f, "AAA"); const st = statSync(f);
  const codec = createStageTokenCodec(Buffer.from("k1"), "ep1");
  const token = codec.issue({ p: f, r: dir, i: "6115428", s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: Date.now() + 60_000, n: "n1" });
  const deps = { repo, media: {} as any, booth: {} as any, codec, log: () => {} };
  const r1 = await commitStageToken({ ...deps, attach: async () => { throw new Error("attach fail"); } }, token, "import");
  assert.ok(r1.itemId && r1.assetId);
  assert.equal(count(t.db, "import_stage_commits"), 1);
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 1);
  const r2 = await commitStageToken(deps, token, "import");
  assert.deepEqual(r2, { replayed: true, decision: "import", itemId: r1.itemId, assetId: r1.assetId });
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 1);
  const f2 = join(dir, "a2.zip"); writeFileSync(f2, "AAB");
  const same = codec.issue({ p: f2, r: dir, i: "6115428", s: 3, m: statSync(f2).mtime.toISOString(), h: sha256Text("AAB"), e: Date.now() + 60_000, n: "n8" });
  const r3 = await commitStageToken(deps, same, "import");
  assert.equal(r3.itemId, r1.itemId);
  assert.equal(count(t.db, "items"), 1); assert.equal(count(t.db, "assets"), 2);
  const other = codec.issue({ p: f, r: dir, i: "6115428", s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: Date.now() + 60_000, n: "n1" });
  await assert.rejects(() => commitStageToken(deps, other, "import"), (e: any) => e.details?.code === "STAGE_TOKEN_CONSUMED");
  t.db.prepare("DELETE FROM items WHERE id=?").run(r1.itemId);
  await assert.rejects(() => commitStageToken(deps, token, "import"), (e: any) => e.details?.code === "STAGE_COMMITTED_OBJECT_DELETED");
  const fresh = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("AAA"), e: Date.now() + 60_000, n: "n9" });
  await assert.rejects(() => commitStageToken({ ...deps, codec: createStageTokenCodec(Buffer.from("k1"), "ep2") }, fresh, "import"), (e: any) => e.details?.code === "STAGE_TOKEN_INVALID");
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("交错：事务外未命中 → A 提交 → B 事务内重查 200；失败回滚可重试", async () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const dir = mkdtempSync(join(tmpdir(), "av-stage2-"));
  const f = join(dir, "b.zip"); writeFileSync(f, "BBB"); const st = statSync(f);
  const codec = createStageTokenCodec(Buffer.from("k2"), "ep2");
  const token = codec.issue({ p: f, r: dir, i: null, s: 3, m: st.mtime.toISOString(), h: sha256Text("BBB"), e: Date.now() + 60_000, n: "n2" });
  const deps = { repo, media: {} as any, booth: {} as any, codec, log: () => {} };
  assert.equal(lookupReceipt(repo, "n2", sha256Text(token)).kind, "none");
  const a = await commitStageToken(deps, token, "import");
  const b = commitStageTokenInTx(deps, codec.verify(token), sha256Text(token), "import");
  assert.deepEqual(b, { replayed: true, decision: "import", itemId: a.itemId, assetId: a.assetId });
  const orig = repo.upsertAsset.bind(repo);
  (repo as any).upsertAsset = () => { throw new Error("boom"); };
  const f3 = join(dir, "c.zip"); writeFileSync(f3, "CCC");
  const token2 = codec.issue({ p: f3, r: dir, i: null, s: 3, m: statSync(f3).mtime.toISOString(), h: sha256Text("CCC"), e: Date.now() + 60_000, n: "n3" });
  await assert.rejects(() => commitStageToken(deps, token2, "import"));
  assert.equal(count(t.db, "import_stage_commits", "nonce=?", "n3"), 0);
  (repo as any).upsertAsset = orig;
  const retry = await commitStageToken(deps, token2, "import");
  assert.ok(retry.assetId);
  rmSync(dir, { recursive: true, force: true }); t.close();
});

test("stage 只读：不建 item/asset/image/tag", async () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const dir = mkdtempSync(join(tmpdir(), "av-stage3-"));
  const f = join(dir, "c.zip"); writeFileSync(f, "CCC");
  const codec = createStageTokenCodec(Buffer.from("k3"), "ep3");
  const out = await stageDownload({ repo, media: {} as any, booth: { fetchItem: async () => ({ itemId: "1" }) } as any, codec, log: () => {}, dataDir: dir, download: async () => ({ path: f, bytes: 3, fileName: "c.zip", finalUrl: "x" }) }, { url: "https://booth.pm/ja/items/1" });
  assert.equal(out.staged, true); assert.ok(out.stageToken);
  assert.equal(count(t.db, "items"), 0); assert.equal(count(t.db, "assets"), 0);
  assert.equal(count(t.db, "item_images"), 0); assert.equal(count(t.db, "tags"), 0);
  rmSync(dir, { recursive: true, force: true }); t.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/import/stage-commit.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

token = `base64url(JSON).base64url(HMAC-SHA256)`；`ep` 每次启动变化。commit 顺序：事务外快路径 → 事务外签名/TTL/realpath/stat/重算 → `BEGIN IMMEDIATE` → 按 nonce 重查 → 归属检查 → NULL 指针 INSERT → 建/复用 item → `upsertAsset` → UPDATE 指针 → COMMIT。事务内不得 `await`。`skip` 只写回执。提交后 `attachBoothMetadata` best-effort，禁止建 item/迁资产。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/import/stage-commit.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/server/src/services/booth.ts > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T4.patch
cp --parents apps/server/src/services/stage-token.ts apps/server/src/services/stage-commit.ts test/import/stage-commit.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/server/src/services/stage-token.ts apps/server/src/services/stage-commit.ts apps/server/src/services/booth.ts test/import/stage-commit.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T4.sha256
git diff --cached --stat   # 必须为空
```
Expected: diff/备份/hash 落盘；索引/HEAD 未变。

---

### Task 5: 预检卡、下载确认与版本关系 UI

**Files:**
- Create: `apps/web/src/components/VersionLinksSection.tsx`
- Create: `apps/web/src/precheck-view.ts`（纯函数：`summaryLabel`、`summaryPriority`、`warningText`）
- Modify: `apps/web/src/components/ImportPanel.tsx`（预检按钮 + 结果卡 + 下载 `stage=true`）
- Test: `test/web/precheck-view.test.ts`

**Interfaces:**
- Produces: `summaryLabel(s: PrecheckResult["summary"]): string`；`summaryPriority(s): number`；`warningText(r: PrecheckResult): string`；`<VersionLinksSection itemId={number} />`。
- Consumes: Task 4 的 `ApiError.details`；Task 1 的 `PrecheckResponse`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryLabel, summaryPriority, warningText } from "../../apps/web/src/precheck-view";

test("标签与优先级固定；弱提示必须写明不是精确重复", () => {
  assert.equal(summaryLabel("exact"), "精确重复（字节相同）");
  assert.equal(summaryLabel("version-candidate"), "同商品，可能是新版本（未证实）");
  assert.ok(summaryPriority("exact") > summaryPriority("version-candidate"));
  assert.ok(summaryPriority("version-candidate") > summaryPriority("same-product"));
  assert.equal(warningText({ match: { weak: { reason: "name_size_hint" } } } as any), "弱提示：同名同尺寸（不是精确重复）");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test test/web/precheck-view.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

ImportPanel 增加“预检”按钮与逐行结果卡；主 UI 下载固定 `stage=true`，完成后展示预检卡并调 commit；跳过提示“文件已保留，未登记”。文案禁止“已验证版本/确认是新版本/实时磁盘检查”。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test test/web/precheck-view.test.ts`
Expected: PASS。

- [ ] **Step 5: 记录交接（不 commit）**

```bash
mkdir -p /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup
git diff -- apps/web/src/components/ImportPanel.tsx > /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T5.patch
cp --parents apps/web/src/components/VersionLinksSection.tsx apps/web/src/precheck-view.ts test/web/precheck-view.test.ts /root/Code/.asset-vault-feature123-20261104/planning/handoff/backup/
sha256sum apps/web/src/components/VersionLinksSection.tsx apps/web/src/precheck-view.ts apps/web/src/components/ImportPanel.tsx test/web/precheck-view.test.ts | tee /root/Code/.asset-vault-feature123-20261104/planning/handoff/P2-T5.sha256
git diff --cached --stat   # 必须为空
```
Expected: diff/备份/hash 落盘；索引/HEAD 未变。
