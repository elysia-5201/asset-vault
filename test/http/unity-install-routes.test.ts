/**
 * T3 Unity 安装 HTTP 路由（真实 Fastify.inject + 真实 TMP 工程；不 listen、不碰 7317/生产）。
 * 口径：loopback 双门（socket peer + Host）；apply 拒绝客户端 path/package；id 必须 UUID；status 零 Unity 调用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerUnityInstallRoutes } from "../../apps/server/src/http/routes/unity-install";
import { UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_URL } from "../../apps/server/src/services/unity-install-core";

const json = (r: { body: string }): any => JSON.parse(r.body);

function makeProject(root: string): string {
  const project = join(root, "My Project");
  mkdirSync(join(project, "Packages"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(join(project, "Packages", "manifest.json"), JSON.stringify({ dependencies: {} }, null, 2) + "\n");
  writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2021.3.22f1\n");
  return project;
}

function setup() {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const dataDir = mkdtempSync(join(tmpdir(), "av-unity-routes-"));
  const spy = { calls: 0 };
  const app = Fastify({ logger: false });
  registerUnityInstallRoutes(app, {
    repo, dataDir, log: () => {},
    unityClient: () => { spy.calls++; throw new Error("must not call"); },
  });
  return { t, repo, dataDir, app, spy };
}

test("preview/apply：真实 HTTP；客户端 path/package 被拒；非法 id 400", async () => {
  const { t, dataDir, app } = setup();
  const root = mkdtempSync(join(tmpdir(), "av-unity-proj-"));
  try {
    const project = makeProject(root);
    const pre = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project } });
    assert.equal(pre.statusCode, 200);
    const p = json(pre);
    assert.equal(p.package.change, "add");
    const apply = await app.inject({ method: "POST", url: "/api/unity/install/apply", payload: { previewId: p.previewId, confirm: true } });
    assert.equal(apply.statusCode, 200);
    assert.equal(json(apply).status, "config_applied");
    const forbidden = await app.inject({ method: "POST", url: "/api/unity/install/apply", payload: { previewId: p.previewId, confirm: true, projectPath: "/evil", package: "evil" } });
    assert.equal(forbidden.statusCode, 400);
    assert.equal(json(forbidden).error.code, "INVALID_INPUT");
    assert.equal(json(forbidden).error.details.code, "UNITY_INSTALL_CLIENT_PATH_FORBIDDEN");
    const traversal = await app.inject({ method: "GET", url: "/api/unity/install/operations/not-a-uuid" });
    assert.equal(traversal.statusCode, 400);
    assert.equal(json(traversal).error.details.code, "UNITY_INSTALL_INVALID_ID");
    const traversalBody = await app.inject({ method: "POST", url: "/api/unity/install/apply", payload: { previewId: "../x", confirm: true } });
    assert.equal(traversalBody.statusCode, 400);
    assert.equal(json(traversalBody).error.details.code, "UNITY_INSTALL_INVALID_ID");
  } finally { rmSync(root, { recursive: true, force: true }); t.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("loopback 双门：非回环 peer 或坏 Host → 400 且零写", async () => {
  const { t, dataDir, app } = setup();
  const root = mkdtempSync(join(tmpdir(), "av-unity-proj-"));
  try {
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const remote = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project }, remoteAddress: "203.0.113.1", headers: { host: "127.0.0.1" } });
    assert.equal(remote.statusCode, 400);
    assert.equal(json(remote).error.details.code, "UNITY_INSTALL_LOOPBACK_ONLY");
    const badHost = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project }, remoteAddress: "127.0.0.1", headers: { host: "10.0.0.5" } });
    assert.equal(badHost.statusCode, 400);
    assert.equal(json(badHost).error.details.code, "UNITY_INSTALL_LOOPBACK_ONLY");
    assert.equal(readFileSync(manifestPath).equals(before), true);
  } finally { rmSync(root, { recursive: true, force: true }); t.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("status 零 Unity 调用；rollback 需 confirm；cancel 生效", async () => {
  const { t, dataDir, app, spy } = setup();
  const root = mkdtempSync(join(tmpdir(), "av-unity-proj-"));
  try {
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    const status = await app.inject({ method: "GET", url: "/api/unity/install/status?projectPath=" + encodeURIComponent(project) });
    assert.equal(status.statusCode, 200);
    assert.equal(json(status).config, "not_applied");
    assert.equal(spy.calls, 0);

    const pre = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project } });
    const p = json(pre);
    const apply = await app.inject({ method: "POST", url: "/api/unity/install/apply", payload: { previewId: p.previewId, confirm: true } });
    assert.equal(apply.statusCode, 200);
    const opId = json(apply).operationId;
    const op = await app.inject({ method: "GET", url: "/api/unity/install/operations/" + opId });
    assert.equal(op.statusCode, 200);
    assert.equal(json(op).status, "config_applied");

    const rbNoConfirm = await app.inject({ method: "POST", url: "/api/unity/install/operations/" + opId + "/rollback", payload: {} });
    assert.equal(rbNoConfirm.statusCode, 400);
    const rb = await app.inject({ method: "POST", url: "/api/unity/install/operations/" + opId + "/rollback", payload: { confirm: true } });
    assert.equal(rb.statusCode, 200);
    assert.equal(json(rb).status, "rolled_back");
    assert.equal(readFileSync(manifestPath).equals(before), true);

    const pre2 = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project } });
    const cancel = await app.inject({ method: "POST", url: "/api/unity/install/previews/" + json(pre2).previewId + "/cancel" });
    assert.equal(cancel.statusCode, 200);
    assert.equal(json(cancel).cancelled, true);

    const probeNoId = await app.inject({ method: "POST", url: "/api/unity/install/probe", payload: {} });
    assert.equal(probeNoId.statusCode, 400);
    assert.equal(json(probeNoId).error.details.code, "UNITY_INSTALL_INVALID_ID");
  } finally { rmSync(root, { recursive: true, force: true }); t.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("Host 严格字面回环：后缀域名/括号后垃圾 400，localhost/[::1] 可达", async () => {
  const { t, dataDir, app } = setup();
  const root = mkdtempSync(join(tmpdir(), "av-unity-proj-"));
  try {
    const project = makeProject(root);
    const manifestPath = join(project, "Packages", "manifest.json");
    const before = readFileSync(manifestPath);
    for (const host of ["127.0.0.1.example.test", "127.0.0.1.nip.io", "[::1]garbage"]) {
      const r = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project }, remoteAddress: "127.0.0.1", headers: { host } });
      assert.equal(r.statusCode, 400, "Host 应被拒: " + host);
      assert.equal(json(r).error.details.code, "UNITY_INSTALL_LOOPBACK_ONLY");
    }
    assert.equal(readFileSync(manifestPath).equals(before), true);
    const localhost = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project }, remoteAddress: "127.0.0.1", headers: { host: "localhost:1234" } });
    assert.equal(localhost.statusCode, 200);
    const v6 = await app.inject({ method: "POST", url: "/api/unity/install/preview", payload: { projectPath: project }, remoteAddress: "::1", headers: { host: "[::1]:8080" } });
    assert.equal(v6.statusCode, 200);
  } finally { rmSync(root, { recursive: true, force: true }); t.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
