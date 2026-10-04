// Deterministic test runner: node --test over every *.test.ts in the repo (tsx loader).
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["test", "packages/core/test", "apps/server/test"];
const files = [];
const walk = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".test.ts")) files.push(p);
  }
};
for (const r of roots) walk(r);
if (files.length === 0) { console.log("no test files found"); process.exit(0); }
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
