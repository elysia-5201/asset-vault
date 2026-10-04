/**
 * AC1-AC12 一键冒烟（串行；每条 AC 单独进程，互不污染）
 *   node --import tsx test/smoke/all.ts
 * 退出码：有 FAIL → 1；只有 PASS/PENDING → 0。
 * 长任务（AC1/AC2/AC4/AC6/AC8）建议先导出 AV_SMOKE_TIMEOUT_MS=600000 并在后台跑。
 */
import { spawnSync } from "node:child_process";
import { ROOT, log } from "./_lib";

const AC = [
  "ac01-scan.ts", "ac02-import-url.ts", "ac03-unitypackage.ts", "ac04-scan-idempotent.ts",
  "ac05-search.ts", "ac06-crash-recovery.ts", "ac07-missing-file.ts", "ac08-list-perf.ts",
  "ac09-core-tests.ts", "ac10-avatar-extract.ts", "ac11-avatar-filter.ts", "ac12-alias-norm.ts",
];

const rows: { ac: string; verdict: string; code: number | null }[] = [];
log(`AV_BASE=${process.env.AV_BASE ?? "http://127.0.0.1:7317/api"}  timeout=${process.env.AV_SMOKE_TIMEOUT_MS ?? 120000}ms`);
for (const f of AC) {
  const r = spawnSync(process.execPath, ["--import", "tsx", `test/smoke/${f}`], { cwd: ROOT, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out);
  const verdict = / FAIL: /.test(out) ? "FAIL" : / PENDING: /.test(out) ? "PENDING" : / PASS\b/.test(out) ? "PASS" : "UNKNOWN";
  rows.push({ ac: f.replace(".ts", ""), verdict, code: r.status });
}
log("\n=== 冒烟汇总 ===");
for (const r of rows) log(`  ${r.verdict.padEnd(7)} ${r.ac} (exit=${r.code})`);
const fails = rows.filter((r) => r.verdict === "FAIL" || r.verdict === "UNKNOWN").length;
if (fails) { log(`${fails} 条 FAIL/UNKNOWN`); process.exitCode = 1; } else log("无 FAIL（PENDING 表示服务/数据/前置未就绪）");
