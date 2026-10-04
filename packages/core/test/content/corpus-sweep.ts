/**
 * 手工诊断脚本（不是 .test.ts，test runner 不会自动跑它）：
 *   对真实素材库做全量容器扫荡 + 大文件内存（RSS）对照。
 * 用法：node --import tsx packages/core/test/content/corpus-sweep.ts
 *
 * 为什么单独放：全量扫荡依赖 /mnt/e 上的本机样本，不适合进单元测试；
 * 但它是"实现是否真的覆盖 39 个 rar / 各种 zip"的可复现证据。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listArchive, readArchiveEntry } from "../../src/archive/list";
import { parseUnityPackage } from "../../src/unitypackage";
import { sha256FileWithSize } from "../../src/hash";

function walk(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 3) return out;
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const n of names) {
    const p = join(root, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

async function main() {
  const roots = ["%LIBRARY%/素材库", "%LIBRARY%/Shinano"];
  const files: string[] = [];
  for (const r of roots) walk(r, files);
  const byExt = (e: string) => files.filter((f) => f.toLowerCase().endsWith(e));
  const groups: [string, string[]][] = [["zip", byExt(".zip")], ["7z", byExt(".7z")], ["rar", byExt(".rar")]];
  const t0 = Date.now();
  const fails: string[] = [];
  let ok = 0, totalEntries = 0;
  for (const [kind, list] of groups) {
    console.log(`\n### ${kind}: ${list.length} 个文件`);
    for (const f of list) {
      const name = f.split("/").pop()!;
      const s = Date.now();
      try {
        const l = await listArchive(f);
        totalEntries += l.entries.length;
        ok++;
        // 每个容器都试着直读一个条目并核对声明大小（rar/7z 的解包路径也因此被覆盖）
        let readNote = "-";
        const target = l.entries.find((e) => !e.isDir && e.size > 0);
        // 大包（solid 7z/rar）解一个条目可能要顺带解开前面所有块 → 只对小包做直读对照
        const smallEnough = statSync(f).size < 20 * 1024 * 1024;
        if (target && smallEnough) {
          const d = await readArchiveEntry(f, target!.path, 64 * 1024 * 1024);
          readNote = `read ${d.length}/${target!.size}${d.length === target!.size ? " OK" : " MISMATCH"}`;
          if (d.length !== target!.size) fails.push(`SIZE ${f} ${target!.path}`);
        }
        console.log(`  OK  ${((Date.now() - s) / 1000).toFixed(1)}s ${l.container} entries=${l.entries.length} trunc=${l.truncated} pwd=${l.passwordProtected} note=${l.note ?? "-"} | ${readNote} | ${name}`);
      } catch (e: any) {
        fails.push(`${f} => ${e?.code ?? e?.name}: ${String(e?.message).slice(0, 160)}`);
        console.log(`  ERR ${((Date.now() - s) / 1000).toFixed(1)}s ${e?.code ?? e?.name}: ${String(e?.message).slice(0, 160)} | ${name}`);
      }
    }
  }
  console.log(`\n=== 汇总: ok=${ok} fail=${fails.length} 总条目=${totalEntries} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s rss=${rss()}MB ===`);
  for (const f of fails) console.log("FAIL:", f);

  // 大文件内存对照：91MB unitypackage 解析 与 627MB rar 流式 sha256
  console.log("\n=== 内存（RSS）对照 ===");
  const up = "%LIBRARY%/MANUKA_ver1.02/MANUKA.unitypackage";
  let m0 = rss();
  const r = await parseUnityPackage(up);
  console.log(`unitypackage 91MB: guids=${r.guidCount} tarEntries=${r.tarEntries} rss ${m0}->${rss()}MB`);
  const big = "%LIBRARY%/Shinano/衣服/AHE_Fullset.rar";
  m0 = rss();
  const t = Date.now();
  const h = await sha256FileWithSize(big);
  console.log(`rar 627MB sha256: bytes=${h.bytes} hash=${h.sha256.slice(0, 16)}… rss ${m0}->${rss()}MB 耗时=${((Date.now() - t) / 1000).toFixed(1)}s`);
  const bigList = await listArchive(big);
  console.log(`rar 627MB 列目录: entries=${bigList.entries.length} rss=${rss()}MB`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
