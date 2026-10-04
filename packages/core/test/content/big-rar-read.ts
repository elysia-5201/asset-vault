/**
 * 手工诊断脚本：大体积 RAR（627 MB，solid）的单条目直读路径 —— 走临时文件解包，不进内存。
 * 用法：node --import tsx packages/core/test/content/big-rar-read.ts
 * 注意：解出的字节最终要以 Buffer 返回给调用方，所以 RSS 至少会涨"该条目大小"。
 */
import { statSync } from "node:fs";
import { listArchive, readArchiveEntry } from "../../src/archive/list";

const f = "%LIBRARY%/Shinano/衣服/AHE_Fullset.rar";
const mb = (n: number) => (n / 1048576).toFixed(1);
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const CAP = 200 * 1024 * 1024;

console.log(`archive: ${f} (${mb(statSync(f).size)} MB) rss=${rss()}MB`);
let t = Date.now();
const l = await listArchive(f);
console.log(`list: entries=${l.entries.length} in ${((Date.now() - t) / 1000).toFixed(2)}s rss=${rss()}MB`);
for (const e of l.entries) console.log(`  ${e.isDir ? "DIR " : "FILE"} ${String(e.size).padStart(12)} ${e.path}`);

const files = l.entries.filter((e) => !e.isDir).sort((a, b) => a.size - b.size);
console.log(`file entries: ${files.length}, smallest=${mb(files[0]?.size ?? 0)}MB, largest=${mb(files[files.length - 1]?.size ?? 0)}MB, total=${mb(files.reduce((s, e) => s + e.size, 0))}MB`);

for (const target of [files[0], files[files.length - 1]]) {
  if (!target) continue;
  t = Date.now();
  try {
    const d = await readArchiveEntry(f, target.path, CAP);
    console.log(`read ${mb(target.size)}MB entry: got ${d.length}/${target.size} ${d.length === target.size ? "OK" : "MISMATCH"} in ${((Date.now() - t) / 1000).toFixed(1)}s rss=${rss()}MB`);
    console.log(`  sha256(${d.subarray(0, 16).toString("hex")}…) first4=${d.subarray(0, 4).toString("hex")}`);
  } catch (err: any) {
    console.log(`read ${mb(target.size)}MB entry FAILED in ${((Date.now() - t) / 1000).toFixed(1)}s: ${err?.code ?? err?.name}: ${String(err?.message).slice(0, 200)}`);
  }
}
