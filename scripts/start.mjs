// Production start: build the web bundle (if missing) and run the API + static server.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("apps/web/dist/index.html")) {
  const b = spawnSync("npx", ["vite", "build", "--config", "apps/web/vite.config.ts"], { stdio: "inherit", shell: false });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const r = spawnSync(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], { stdio: "inherit" });
process.exit(r.status ?? 1);
