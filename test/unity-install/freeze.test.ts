/**
 * T5 freeze gate: docs/api.md Unity install section + root registration + startup recovery.
 *
 * This is a static/behavioral gate, not a DOM or real-Unity test. It extracts the
 * real Unity editor section (not a global substring) and includes negative controls
 * so a missing endpoint/registration is detected rather than silently passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../apps/server/src/http/routes.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../../apps/server/src/server.ts", import.meta.url), "utf8");

const ENDPOINTS = [
  "/unity/install/preview",
  "/unity/install/apply",
  "/unity/install/status",
  "/unity/install/probe",
  "/unity/install/operations/:id",
  "/unity/install/operations/:id/rollback",
  "/unity/install/previews/:previewId/cancel",
];

/** Extract the real Unity editor section; the install subsection must live inside it. */
function unityEditorSection(text: string): string {
  const start = text.indexOf("## Unity 编辑器");
  assert.ok(start >= 0, "docs/api.md missing Unity editor section");
  const next = text.indexOf("\n## ", start + 1);
  return next >= 0 ? text.slice(start, next) : text.slice(start);
}

function assertDocsHasEndpoints(text: string): void {
  const section = unityEditorSection(text);
  for (const p of ENDPOINTS) {
    assert.ok(section.includes(p), "docs missing endpoint " + p);
  }
  assert.ok(section.includes("UNITY_INSTALL_"), "docs missing UNITY_INSTALL_* details");
  assert.ok(section.includes("422"), "docs missing 422 mapping");
  assert.ok(section.includes("confirmReplace"), "docs missing confirmReplace");
}

function assertRoutesRegistered(text: string): void {
  assert.ok(text.includes("registerUnityInstallRoutes"), "routes missing registerUnityInstallRoutes");
  assert.ok(text.includes("dataDir: deps.dataDir"), "routes missing dataDir wiring");
}

function assertRecoveryRegistered(text: string): void {
  const recoveryCall = text.indexOf("recoverInterruptedOperations({");
  const openDbCall = text.indexOf("openDatabase(");
  assert.ok(recoveryCall >= 0, "server missing recoverInterruptedOperations call");
  assert.ok(openDbCall >= 0, "server missing openDatabase call");
  assert.ok(recoveryCall < openDbCall, "recovery must run before openDatabase");
}

test("docs/api.md Unity editor section lists all install endpoints and error details", () => {
  assertDocsHasEndpoints(api);
});

test("docs negative control: removing an endpoint is detected", () => {
  const broken = api.replace("/unity/install/probe", "/unity/install/removed");
  assert.throws(() => assertDocsHasEndpoints(broken), /missing endpoint/);
});

test("routes.ts registers Unity install routes with dataDir", () => {
  assertRoutesRegistered(routes);
});

test("routes negative control: missing registration is detected", () => {
  const broken = routes.replaceAll("registerUnityInstallRoutes", "registerOtherRoutes");
  assert.throws(() => assertRoutesRegistered(broken), /registerUnityInstallRoutes/);
});

test("server.ts calls recovery before opening the database", () => {
  assertRecoveryRegistered(server);
});

test("server negative control: missing recovery is detected", () => {
  const broken = server.replaceAll("recoverInterruptedOperations", "recoverOther");
  assert.throws(() => assertRecoveryRegistered(broken), /recoverInterruptedOperations/);
});
