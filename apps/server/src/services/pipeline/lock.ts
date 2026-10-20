/**
 * 单写入者锁（v0.6.0）
 *
 * 背景（verifier A1/B3④）：jobs 与 index_tasks 都没有 owner/lease。两个进程（CLI + 桌面版
 * 端口回退）同时跑 runner 会互相抢作业、互相重置 running 任务。
 * 这里用一个 pid 文件把"谁有权跑流水线"定下来：拿不到锁的实例只提供 HTTP 读/写接口，
 * 不启动 pipeline（也就能安全地退回同步索引或直接让任务排队）。
 *
 * 注意：这不是数据库锁，只是进程级互斥；崩溃留下的租约通过 pid 存活探测自动失效。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

export interface PipelineLock {
  acquired: boolean;
  reason?: string;
  release: () => void;
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

export function acquirePipelineLock(dataDir: string): PipelineLock {
  const file = join(dataDir, "pipeline.lock");
  const noop = () => {};
  try {
    if (existsSync(file)) {
      let prev: any = null;
      try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { prev = null; }
      if (prev && Number(prev.pid) !== process.pid && alive(Number(prev.pid))) {
        return { acquired: false, reason: "另一个实例持有锁（pid " + prev.pid + " @ " + (prev.host ?? "?") + "）", release: noop };
      }
      // 同一 pid（重启后复用）或进程已死 → 视为过期锁
    }
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    return {
      acquired: true,
      release: () => {
        try {
          const cur = JSON.parse(readFileSync(file, "utf8"));
          if (Number(cur?.pid) === process.pid) unlinkSync(file);
        } catch { /* 已被别人接管或不存在 */ }
      },
    };
  } catch (e) {
    return { acquired: false, reason: "写锁失败: " + String((e as Error)?.message ?? e), release: noop };
  }
}
