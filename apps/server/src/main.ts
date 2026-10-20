import { readFileSync } from "node:fs";
import { startAssetVault } from "./server";

/** FIX-03：CLI 启动必须把真实包版本传下去（否则 /api/health 与 update-check 永远 0.1.0）。 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch { return "0.0.0"; }
}

const handle = await startAssetVault({
  port: Number(process.env.PORT ?? 7317),
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: process.env.ASSETVAULT_DATA,
  version: readVersion(),
});

const shutdown = async (sig: string) => {
  handle.log("shutdown (" + sig + ")");
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
