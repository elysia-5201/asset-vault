// 崩溃子进程：领取一个 job + 一个 hash 任务后停住，等父进程 SIGKILL。
import { openDatabase } from "../../apps/server/src/db/migrate.ts";
import { Repo } from "../../apps/server/src/db/repo.ts";

const dbFile = process.argv[2];
const db = openDatabase(dbFile);
const repo = new Repo(db);
const job = repo.claimNextJob("child#crash", { leaseMs: 60_000 });
const task = repo.claimIndexTask("hash");
process.stdout.write("READY " + JSON.stringify({ jobId: job?.id ?? null, token: job?.lease_token ?? null, taskId: task?.id ?? null }) + "\n");
setInterval(() => {}, 1000);
