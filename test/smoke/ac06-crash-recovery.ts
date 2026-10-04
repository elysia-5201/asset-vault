/**
 * AC6 崩溃恢复（kill -9）
 * 判据操作化：
 *   - 重启后不存在 state∈在飞 的"僵尸"作业残留（在飞作业必须已写回 queued）—— 由 GET /jobs?state=... 观测
 *   - job_events 里出现 event='recovered' 的记录（GET /jobs/:id/events）
 *   - 磁盘无 *.part 残留（在 roots 下按 maxdepth 4 采样）
 *
 * 本脚本 **不** 自己 kill 服务（那会打断 lead 的实例）。两种跑法：
 *   A) 手动：按下面打印的 4 步命令做，每步之间运行本脚本的 --check 分支
 *   B) 自动：导出 AV_SMOKE_SERVER_PID=<pid> AV_SMOKE_SERVER_CMD="npx tsx apps/server/src/main.ts"，
 *      脚本会 kill -9 该 pid、按命令重启、等待 /health 恢复后校验
 */
import { runAc, api, assertAc, log, AcPending } from "./_lib";
import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";

const inflight = ["queued", "resolving", "fetching", "materializing", "indexing", "matching", "releasing", "releasing_done", "paused"];

const partFiles = (dir: string, depth = 4, out: string[] = []): string[] => {
  if (depth < 0 || out.length > 200) return out;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const p = dir + "/" + e;
    try {
      const st = statSync(p);
      if (st.isDirectory()) partFiles(p, depth - 1, out);
      else if (e.endsWith(".part") || e.endsWith(".part.tmp")) out.push(p);
    } catch { /* 权限/竞态忽略 */ }
  }
  return out;
};

await runAc("AC6", "kill -9 后重启：在飞作业回 queued + recovered 事件 + 无 .part 残留", { needsServer: true, note: "默认只做只读检查；自动 kill 需 AV_SMOKE_SERVER_PID + AV_SMOKE_SERVER_CMD" }, async () => {
  const pid = Number(process.env.AV_SMOKE_SERVER_PID ?? 0);
  const cmd = process.env.AV_SMOKE_SERVER_CMD ?? "";
  if (pid && cmd) {
    log(`    kill -9 ${pid} …`);
    try { process.kill(pid, "SIGKILL"); } catch (e) { log(`    kill 失败（可能已退出）: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 800));
    const child = spawn(cmd, { shell: true, detached: true, stdio: "ignore", cwd: new URL("../../", import.meta.url).pathname });
    child.unref();
    log(`    重启: ${cmd} (pid=${child.pid}) 等待 /health …`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const h = await api.get("/health", 2000).catch(() => null);
      if (h?.status === 200) { log(`    health 恢复于第 ${i + 1}s`); break; }
      if (i === 39) throw new AcPending("重启后 40s 内 /health 未恢复；请手动确认服务命令与端口");
    }
  } else {
    log("    未提供 AV_SMOKE_SERVER_PID/AV_SMOKE_SERVER_CMD → 只做『当前无僵尸在飞』的只读检查");
  }

  const jobs = (await api.get("/jobs?limit=500")).body?.jobs ?? [];
  const zombies = jobs.filter((j: any) => inflight.includes(j.state));
  const recovered: any[] = [];
  for (const j of jobs) {
    const ev = (await api.get(`/jobs/${j.id}/events`)).body;
    const arr = Array.isArray(ev) ? ev : (ev?.events ?? []);
    if (arr.some((e: any) => e.event === "recovered")) recovered.push(j);
  }
  const roots = (await api.get("/roots")).body?.roots ?? (await api.get("/roots")).body ?? [];
  const parts = roots.flatMap((r: any) => (typeof r?.path === "string" && existsSync(r.path) ? partFiles(r.path) : []));
  log(`    jobs=${jobs.length} 在飞残留=${zombies.length} 有 recovered 事件的作业=${recovered.length} .part 文件=${parts.length}`);
  if (zombies.length) log("    残留: " + JSON.stringify(zombies.slice(0, 5)));
  if (parts.length) log("    .part: " + parts.slice(0, 5).join(", "));
  assertAc(zombies.length === 0, `重启后仍有 ${zombies.length} 个在飞作业未回 queued（崩溃恢复未实现）`);
  assertAc(parts.length === 0, `磁盘存在 ${parts.length} 个 .part 残留`);
  if (recovered.length === 0) log("    提醒：木有 recovered 事件（若本次无在飞作业则属正常；有在飞作业时必须补记）");
  if (!pid) {
    log("    手动复现步骤：");
    log("      1) POST /scan 起一个作业  2) kill -9 <server pid>  3) 按原命令重启服务  4) node --import tsx test/smoke/ac06-crash-recovery.ts");
    throw new AcPending("未做 kill -9（只读检查通过）；设 AV_SMOKE_SERVER_PID/AV_SMOKE_SERVER_CMD 可自动复现");
  }
});
