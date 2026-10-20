// 第二实例子进程：尝试获取 pipeline 锁，报告后短暂持有并退出。
import { acquirePipelineLock } from "../../apps/server/src/services/pipeline/lock.ts";

const dir = process.argv[2];
const lock = acquirePipelineLock(dir);
process.stdout.write("ACQUIRED " + String(lock.acquired) + "\n");
setTimeout(() => { try { lock.release(); } catch { /* ignore */ } process.exit(0); }, 1200);
