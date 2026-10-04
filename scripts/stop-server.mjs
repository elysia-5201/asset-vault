// 按 cmdline 精确停掉 AssetVault server（避免 pkill -f 匹配到调用者自己）。用法：node scripts/stop-server.mjs
import { readdirSync, readFileSync } from "node:fs";

const self = process.pid, parent = process.ppid;
const killed = [];
for (const d of readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  const pid = Number(d);
  if (pid === self || pid === parent) continue;
  try {
    const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (cmd.includes("apps/server/src/main.ts") && !cmd.includes("stop-server")) {
      process.kill(pid, "SIGKILL");
      killed.push(`${pid}: ${cmd.slice(0, 90)}`);
    }
  } catch { /* 进程已退出 */ }
}
console.log(killed.length ? "killed:\n" + killed.join("\n") : "no assetvault server running");
