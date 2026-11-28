import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [bundlePath, browserPath, mode = "search2"] = process.argv.slice(2);
assert.ok(bundlePath && browserPath, "Pass the staged portable payload and Chromium executable");
const stage = resolve(bundlePath);
mkdirSync(resolve(".worktrees"), { recursive: true });
const scratch = mkdtempSync(resolve(".worktrees/search-ui-"));
const bundle = resolve(stage, "apps/desktop/build");
const { startAssetVault } = await import(pathToFileURL(resolve(bundle, "server.mjs")));
const server = await startAssetVault({
  port: 0, host: "127.0.0.1", schemaFile: resolve(bundle, "schema.sql"), seedFile: resolve("config/avatars.seed.json"),
  webDistDir: resolve(stage, "apps/web/dist"), dataDir: resolve(scratch, "data"), logsDir: resolve(scratch, "logs"),
});
const create = server.repo.connection.transaction(() => {
  for (let i = 1; i <= 1500; i++) server.repo.createItem({
    title: "Fixture Asset " + String(i).padStart(4, "0"),
    source_site: "booth", source_item_id: String(7800000 + i), status: "active",
  });
});
create();
const profile = resolve(scratch, "browser-profile");
let browserErrors = "";
const browser = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-extensions", "--no-first-run",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1440,900", "about:blank",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
browser.on("error", (error) => { browserErrors += error.message; });
browser.stderr.on("data", (data) => { browserErrors = (browserErrors + String(data)).slice(-3000); });
let socket;
async function until(check, description, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const answer = await check();
    if (answer) return answer;
    await wait(50);
  }
  throw new Error("Timed out: " + description + "\n" + browserErrors);
}

try {
  const debugPort = await until(() => {
    const name = join(profile, "DevToolsActivePort");
    return existsSync(name) ? Number(readFileSync(name, "utf8").split("\n")[0]) : undefined;
  }, "Chromium startup");
  const pages = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const requests = new Map();
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error("CDP timeout: " + method)); }, 10_000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "window.avLongTasks=[];"
    + "new PerformanceObserver(l=>window.avLongTasks.push(...l.getEntries().map(x=>x.duration))).observe({type:'longtask',buffered:true});" });
  const address = server.app.server.address();
  await cdp("Page.navigate", { url: "http://127.0.0.1:" + address.port + "/" });
  const shown = await until(() => evaluate("document.querySelector('.card-title') ? performance.now() : 0"), "first rendered cards");
  const firstCards = await evaluate("document.querySelectorAll('.card').length");
  if (mode === "search2") assert.ok(firstCards < 120, "first render mounts a bounded set of cards");

  const xy = await evaluate("(()=>{const r=document.querySelector('.card').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+30)}})()");
  await evaluate("window.avFrames=[];window.avScrolling=true;let lastFrame=performance.now();requestAnimationFrame(function report(t){"
    + "if(!window.avScrolling)return;window.avFrames.push(t-lastFrame);lastFrame=t;requestAnimationFrame(report)})");
  for (let i = 0; i < 22; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...xy, deltaX: 0, deltaY: i % 3 ? 380 : -190 });
    await wait(55);
  }
  const scroll = await evaluate("window.avScrolling=false;({mounted:document.querySelectorAll('.card').length,longTasks:window.avLongTasks,"
    + "frames:window.avFrames,scrolled:document.querySelector('.card').closest('.col-scroll').scrollTop})");
  assert.ok(scroll.scrolled > 0, "wheel scrolling reaches the results list");
  if (mode === "search2") {
    assert.ok(scroll.mounted < 120);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", modifiers: 2 });
    const focused = await evaluate("document.activeElement.getAttribute('aria-label')");
    assert.equal(focused, "搜索素材");
    await cdp("Input.insertText", { text: "7800123" });
    await wait(80);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await cdp("Input.insertText", { text: "7800124" });
    await until(() => evaluate("Array.from(document.querySelectorAll('.card-title')).map(e=>e.textContent).join('') === 'Fixture Asset 0124'"), "latest search wins");
    await evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='列表视图').click()");
    await until(() => evaluate("!!document.querySelector('.search-results-list .card')"), "list layout");
  }
  const sorted = scroll.frames.toSorted((a, b) => a - b);
  const metrics = { mode, firstCards, firstResultMs: +shown.toFixed(2), mountedAfterScroll: scroll.mounted, scrollTop: scroll.scrolled,
    frameSamples: sorted.length, frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], longTasksMs: scroll.longTasks };
  const out = resolve(scratch, "browser-metrics.json");
  writeFileSync(out, JSON.stringify(metrics, null, 2) + "\n");
  console.log(JSON.stringify({ metrics, out }));
} finally {
  socket?.close();
  browser.kill();
  await server.close();
}
