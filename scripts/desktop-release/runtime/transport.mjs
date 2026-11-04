// transport.mjs r3 — resolve-based boundary, no string prefix, ancestor link check.
import { resolve, dirname, basename, sep, isAbsolute } from "node:path";
import { lstatSync, realpathSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

export function resolveDest(root, rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("TRANSPORT: empty rel");
  if (isAbsolute(rel)) throw new Error("TRANSPORT: absolute rel: " + rel);
  if (/^[a-zA-Z]:/.test(rel)) throw new Error("TRANSPORT: drive letter in rel: " + rel);
  if (rel.startsWith("\\\\") || rel.startsWith("//")) throw new Error("TRANSPORT: UNC rel: " + rel);
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === "..")) throw new Error("TRANSPORT: dotdot component: " + rel);
  if (parts.some((p) => p === "" )) throw new Error("TRANSPORT: empty component: " + rel);
  const rootAbs = resolve(root);
  const dest = resolve(rootAbs, rel);
  if (dest !== rootAbs && !dest.startsWith(rootAbs + sep)) throw new Error("TRANSPORT: dest outside root: " + dest);
  const name = basename(dest);
  if (name.includes(sep) || name.includes("/") || name.includes("\\")) throw new Error("TRANSPORT: separator in basename");
  return dest;
}

export function assertNoLinkAncestors(root, dest) {
  const rootAbs = resolve(root);
  let cur = dirname(dest);
  while (cur.length >= rootAbs.length) {
    if (existsSync(cur)) {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) throw new Error("TRANSPORT: symlink ancestor: " + cur);
      const real = realpathSync(cur);
      if (real !== cur && !real.startsWith(rootAbs)) throw new Error("TRANSPORT: realpath escapes root: " + real);
    }
    if (cur === rootAbs) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

export function stageFile(root, rel, bytes) {
  const dest = resolveDest(root, rel);
  assertNoLinkAncestors(root, dest);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return dest;
}
