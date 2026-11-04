// manifest-gen.mjs r3 — action whitelist + sha64 on both old and new.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ACTIONS = new Set(["replace", "replace-LAST", "add-new-exclusive", "DO-NOT-WRITE"]);
const INDEX = "apps/web/dist/index.html";
const randomHex8 = () => Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const utcStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; };
const sha64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export function buildManifest(entries, opts = {}) {
  const releaseId = opts.releaseId ?? randomHex8();
  const stamp = opts.stamp ?? utcStamp();
  if (!/^[0-9a-f]{8}$/.test(releaseId)) throw new Error("MANIFEST: releaseId must be 8 hex");
  if (!/^[0-9]{8}-[0-9]{6}$/.test(stamp)) throw new Error("MANIFEST: stamp must be yyyyMMdd-HHmmss");
  const seen = new Set();
  let indexCount = 0;
  let newJs = 0;
  const payload = entries.map((e) => {
    if (!e || typeof e.rel !== "string") throw new Error("MANIFEST: rel missing");
    if (!Object.prototype.hasOwnProperty.call(e, "old")) throw new Error("MANIFEST: old must be present (literal null for new): " + e.rel);
    if (!sha64(e.new)) throw new Error("MANIFEST: new not sha64: " + e.rel);
    if (e.old !== null && !sha64(e.old)) throw new Error("MANIFEST: old not sha64: " + e.rel);
    if (!Number.isInteger(e.bytes) || e.bytes < 0) throw new Error("MANIFEST: bytes not integer: " + e.rel);
    if (!ACTIONS.has(e.action)) throw new Error("MANIFEST: action not whitelisted: " + e.action);
    const rel = e.rel.replace(/\\/g, "/");
    if (seen.has(rel)) throw new Error("MANIFEST: duplicate rel: " + rel);
    seen.add(rel);
    if (rel === INDEX) {
      indexCount++;
      if (e.action !== "replace-LAST") throw new Error("MANIFEST: index action must be replace-LAST");
      if (e.old === null) throw new Error("MANIFEST: index old must be a pin");
    } else if (e.action === "replace-LAST") {
      throw new Error("MANIFEST: replace-LAST only on index: " + rel);
    }
    if (e.action === "add-new-exclusive") {
      newJs++;
      if (e.old !== null) throw new Error("MANIFEST: add-new-exclusive old must be null: " + rel);
    }
    return { rel, bytes: e.bytes, old: e.old, new: e.new, action: e.action };
  });
  if (indexCount !== 1) throw new Error("MANIFEST: index must appear exactly once");
  if (newJs !== 1) throw new Error("MANIFEST: exactly one add-new-exclusive, got " + newJs);
  return {
    schema: "av-exec-manifest/v1",
    appRoot: opts.appRoot ?? "E:\\tool\\asset-vault\\dist-desktop\\win-unpacked\\resources\\app",
    dataPrivate: opts.dataPrivate ?? "E:\\tool\\asset-vault\\.av-apply-private",
    releaseId,
    stamp,
    payload
  };
}
