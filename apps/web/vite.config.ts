import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@core": fileURLToPath(new URL("../../packages/core/src", import.meta.url)) } },
  server: { port: 7318, proxy: { "/api": "http://127.0.0.1:7317" } },
  build: { outDir: "dist", emptyOutDir: true },
});
