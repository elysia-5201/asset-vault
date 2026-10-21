#!/usr/bin/env node
/**
 * Windows script hygiene check (FIX-06 / AUD-06 F-AUD06-1).
 *
 * Why: cmd.exe is unreliable with LF-only batch files, and Windows Script Host
 * mis-parses UTF-8 (no BOM) VBS comments - the shipped autostart VBS failed with
 * "Object required: 'sh'" because the LF-only comment line swallowed "Set sh=...".
 *
 * Rules enforced for every tracked *.cmd / *.vbs:
 *   1) CRLF line endings only (no lone LF, no lone CR).
 *   2) .vbs must be ASCII-only, or UTF-16LE with BOM. UTF-8 without BOM is rejected
 *      (WSH reads it as ANSI and can mis-tokenise non-ASCII text).
 *
 * Usage: node scripts/check-windows-scripts.mjs [--root <dir>]
 * Exit 1 on violations. Read-only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? args[rootArg + 1] : process.cwd();
const SKIP = new Set(["node_modules", ".git", "logs", "data", "data-dev", "dist-desktop", ".npm-cache"]);
const problems = [];
const checked = [];

function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith("rollback-") || name === ".tmp-av") continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(cmd|vbs)$/i.test(name)) continue;
    checked.push(p);
    const buf = readFileSync(p);
    const rel = relative(root, p).replace(/\\/g, "/");
    // UTF-16LE BOM: ff fe
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    if (!utf16) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) { problems.push(rel + ": lone LF at byte " + i + " (needs CRLF)"); break; }
        if (buf[i] === 0x0d && (i + 1 >= buf.length || buf[i + 1] !== 0x0a)) { problems.push(rel + ": lone CR at byte " + i + " (needs CRLF)"); break; }
      }
    }
    if (/\.vbs$/i.test(name) && !utf16) {
      const bad = [];
      for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) { bad.push(i + ":0x" + buf[i].toString(16)); if (bad.length >= 3) break; }
      if (bad.length) problems.push(rel + ": non-ASCII bytes in VBS without UTF-16LE BOM (" + bad.join(",") + "); save as ASCII or UTF-16LE");
    }
  }
}

walk(root);
for (const p of checked) console.log("checked " + relative(root, p).replace(/\\/g, "/"));
if (problems.length) {
  console.error("\nWindows script hygiene FAILED (" + problems.length + "):");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\nOK: " + checked.length + " file(s) are CRLF and VBS encoding is WSH-safe.");
