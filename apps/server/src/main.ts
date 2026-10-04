import { startAssetVault } from "./server";

const handle = await startAssetVault({
  port: Number(process.env.PORT ?? 7317),
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: process.env.ASSETVAULT_DATA,
});

const shutdown = async (sig: string) => {
  handle.log("shutdown (" + sig + ")");
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
