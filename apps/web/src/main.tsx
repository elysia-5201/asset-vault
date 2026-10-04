import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initApi } from "./api";
import "./styles.css";

async function boot(): Promise<void> {
  await initApi();
  const el = document.getElementById("root");
  if (!el) throw new Error("#root 不存在");
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
