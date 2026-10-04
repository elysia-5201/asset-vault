/**
 * AC9 core 纯函数单测全绿（真实 fixture）
 * 判据操作化：
 *   - packages/core/test 下的 *.test.ts 必须存在（否则 PENDING：core 测试尚未落地）
 *   - `node scripts/test.mjs` 退出码 0，且输出含 "# fail 0"
 *   - 打印被测的 core 测试文件清单作为"真实 fixture 存在"的证据
 * 注意：本脚本不是 *.test.ts，不会被打包进 scripts/test.mjs，无递归。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { runAc, assertAc, log, AcPending, ROOT } from "./_lib";

const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = dir + "/" + e;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
};

await runAc("AC9", "node scripts/test.mjs 全绿（含 packages/core 真实 fixture）", { needsServer: false }, async () => {
  const coreTests = walk(`${ROOT}/packages/core/test`);
  if (coreTests.length === 0) throw new AcPending(`packages/core/test/ 下没有 *.test.ts（core-identify / core-content 的用例尚未落地）；落地后重跑本脚本`);
  log(`    core 测试文件 ${coreTests.length} 个:`);
  for (const f of coreTests) log("      " + f.replace(ROOT + "/", ""));
  const r = spawnSync(process.execPath, ["scripts/test.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const tail = out.split("\n").slice(-25).join("\n");
  log("    scripts/test.mjs 末 25 行:\n" + tail.split("\n").map((l) => "      " + l).join("\n"));
  assertAc(r.status === 0, `node scripts/test.mjs 退出码 ${r.status}（应为 0）`);
  assertAc(/# fail 0/.test(out), "测试输出里没有 '# fail 0'（用 tail 核对）");
});
