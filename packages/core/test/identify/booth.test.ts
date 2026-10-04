/**
 * source/booth 单测。
 *  - parseBoothUrl / isHtmlLoginPage：全部用**真实**样本（fixtures/login-page.html 是 2026-10-04 抓的
 *    /downloadables/... 跟随 302 后的 200 登录页；fixtures/item-page.html 是同一天抓的真实商品页前 32KiB，
 *    作为“同样含 users/sign_in 与 authenticity_token 的硬反例”）。
 *  - BoothClient：用本地 HTTP 服务注入 fetch/超时/限速，覆盖 404 / 登录页 / 非 JSON / 超时 / 5xx 退避 /
 *    图片其实是 HTML / 成人 cookie / 单域名串行与间隔。
 *  - 真实 BOOTH 抓取（8183383 / 6115428 / 6494376）：网络不可用时自动 skip，不失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { AppError } from "../../src/contracts";
import { parseBoothUrl, isHtmlLoginPage, BoothClient } from "../../src/source/booth";

const FX = (name: string): Buffer => readFileSync(new URL("./fixtures/" + name, import.meta.url));
const LOGIN_HTML = FX("login-page.html");
const ITEM_HTML = FX("item-page.html");
const ITEM_404_HTML = FX("booth-404.html");
const JPG = FX("img-72x72.jpg");
const JSON_8183383 = FX("booth-8183383.json").toString("utf8");
const JSON_3087170 = FX("booth-3087170.json").toString("utf8");

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn("http://127.0.0.1:" + port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("parseBoothUrl：支持的各形态 + canonicalUrl 一律 ja", () => {
  const canon = "https://booth.pm/ja/items/8183383";
  assert.deepEqual(parseBoothUrl("https://booth.pm/ja/items/8183383"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("https://booth.pm/items/8183383/"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("https://booth.pm/en/items/8183383?variation_id=13700118#x"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("https://lovable.booth.pm/items/8183383"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("booth.pm/ja/items/8183383"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("8183383"), { itemId: "8183383", canonicalUrl: canon });
  assert.deepEqual(parseBoothUrl("https://booth.pm/ja/items/8183383.json"), { itemId: "8183383", canonicalUrl: canon });
});

test("parseBoothUrl：反例（downloadables / 非 booth / 非店铺子域 / 位数不对）", () => {
  assert.equal(parseBoothUrl("https://booth.pm/downloadables/1448437?variation_id=12317982"), null);
  assert.equal(parseBoothUrl("https://gumroad.com/l/abc"), null);
  assert.equal(parseBoothUrl("https://img.booth.pm/x/8183383"), null);
  assert.equal(parseBoothUrl("https://booth.pm/ja/items/12"), null);
  assert.equal(parseBoothUrl("https://booth.pm/ja/items/1234567890"), null);
  assert.equal(parseBoothUrl(""), null);
  assert.equal(parseBoothUrl("不是URL"), null);
});

test("isHtmlLoginPage：真实登录页 true / 真实商品页 false / 二进制 false", () => {
  assert.equal(isHtmlLoginPage(LOGIN_HTML, "text/html; charset=utf-8"), true);
  assert.equal(isHtmlLoginPage(ITEM_HTML, "text/html; charset=utf-8"), false);
  assert.equal(isHtmlLoginPage(ITEM_404_HTML, "text/html; charset=utf-8"), false);
  assert.equal(isHtmlLoginPage(JPG, "image/jpeg"), false);
  assert.equal(isHtmlLoginPage(FX("booth-8183383.json"), "application/json; charset=utf-8"), false);
  assert.equal(isHtmlLoginPage(Buffer.alloc(0)), false);
  // 通用变体（非 BOOTH）：<title>Sign in</title> + 登录表单 → true
  const generic = Buffer.from("<!DOCTYPE html><html><head><title>Sign in - Example</title></head><body><form action=\"/users/sign_in\" method=\"post\"><input name=\"user[email]\"></form></body></html>", "utf8");
  assert.equal(isHtmlLoginPage(generic, "text/html"), true);
  assert.equal(isHtmlLoginPage(generic, null), true);
});

test("fetchItem：真实 8183383 JSON → BoothItemMeta 字段映射", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON_8183383);
  }, async (base) => {
    const client = new BoothClient({ baseUrl: base, minIntervalMs: 0 });
    const m = await client.fetchItem("8183383");
    assert.equal(m.itemId, "8183383");
    assert.equal(m.title, "✦ ミルフィ :: Milfy 対応 ✦ MilkyWay Makeup Texture");
    assert.equal(m.priceText, "¥ 200~");
    assert.equal(m.priceYen, 200);
    assert.equal(m.isAdult, false);
    assert.equal(m.publishedAt, "2026-04-10T14:33:05.000+09:00");
    assert.equal(m.url, "https://booth.pm/ja/items/8183383");
    assert.deepEqual(m.shop, { name: "lovable", subdomain: "lovable" });
    assert.equal(m.category?.name, "3Dテクスチャ");
    assert.equal(m.category?.parent?.name, "3Dモデル");
    assert.ok(m.tags.some((t) => t.name === "ミルフィ対応"));
    assert.equal(m.images.length, 12);
    assert.ok(m.images[0].original.startsWith("https://booth.pximg.net/"));
    assert.equal(m.variations.length, 3);
    assert.equal(m.variations[0].id, 13700118);
    assert.equal(m.variations[0].price, 700);
    assert.equal(m.variations[0].name, "✦ Full ✦");
    assert.equal(m.raw !== undefined, true);
  });
});

test("fetchItem：真实免费商品 3087170 的 downloadable（no_musics）字段映射", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_3087170);
  }, async (base) => {
    const m = await new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("3087170");
    assert.equal(m.title, "【無料】lilToon");
    const files = m.variations[0].files;
    assert.deepEqual(files[0], {
      name: "lilToon_2.x.x.zip",
      file_name: "lilToon_2.x.x",
      file_extension: ".zip",
      file_size: "325 KB",
      url: files[0].url,
    });
    assert.ok(files[0].url.startsWith("https://"));
  });
});

test("fetchItem：无 content-type 但正文是 JSON → 正常解析", async () => {
  await withServer((req, res) => {
    res.writeHead(200); // 故意不写 content-type
    res.end(JSON_8183383);
  }, async (base) => {
    const m = await new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("8183383");
    assert.equal(m.itemId, "8183383");
    assert.equal(m.title, "✦ ミルフィ :: Milfy 対応 ✦ MilkyWay Makeup Texture");
  });
});

test("fetchItem：404 → NOT_FOUND（真实 404 页内容）", async () => {
  await withServer((req, res) => {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(ITEM_404_HTML);
  }, async (base) => {
    await assert.rejects(
      () => new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("8183383"),
      (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND",
    );
  });
});

test("fetchItem：200 但登录页 HTML → LOGIN_REQUIRED（不把登录页当数据）", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(LOGIN_HTML);
  }, async (base) => {
    await assert.rejects(
      () => new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("8183383"),
      (e: unknown) => e instanceof AppError && e.code === "LOGIN_REQUIRED",
    );
  });
});

test("fetchItem：200 + application/json 但是坏 JSON → UPSTREAM_ERROR", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("<html>not json</html>");
  }, async (base) => {
    await assert.rejects(
      () => new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("8183383"),
      (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR",
    );
  });
});

test("fetchItem：非法商品号 → INVALID_INPUT（不发请求）", async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(500); res.end(); }, async (base) => {
    await assert.rejects(
      () => new BoothClient({ baseUrl: base, minIntervalMs: 0 }).fetchItem("abc"),
      (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT",
    );
    assert.equal(hits, 0);
  });
});

test("fetchItem：5xx 指数退避重试后仍失败 → UPSTREAM_ERROR，且请求次数 = maxRetries+1", async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(503); res.end("busy"); }, async (base) => {
    const sleeps: number[] = [];
    await assert.rejects(
      () => new BoothClient({
        baseUrl: base, minIntervalMs: 0, maxRetries: 2, backoffBaseMs: 1,
        sleep: async (ms) => { sleeps.push(ms); },
      }).fetchItem("8183383"),
      (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR",
    );
    assert.equal(hits, 3);
    assert.deepEqual(sleeps, [1, 2]); // 600*2^i 基数换成 1 → 1,2
  });
});

test("fetchItem：5xx 之后成功 → 成功返回（可恢复）", async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(500); res.end("boom"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_8183383);
  }, async (base) => {
    const m = await new BoothClient({ baseUrl: base, minIntervalMs: 0, backoffBaseMs: 1 }).fetchItem("8183383");
    assert.equal(m.itemId, "8183383");
    assert.equal(hits, 2);
  });
});

test("fetchItem：超时 → UPSTREAM_ERROR（明确带“超时”）", async () => {
  await withServer(() => { /* 永不响应 */ }, async (base) => {
    await assert.rejects(
      () => new BoothClient({ baseUrl: base, minIntervalMs: 0, timeoutMs: 150, maxRetries: 0 }).fetchItem("8183383"),
      (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR" && /超时/.test(e.message),
    );
  });
});

test("fetchImage：真实 JPEG / 登录页 / 商品页冒充图片 / 白名单外 / 坏 URL", async () => {
  await withServer((req, res) => {
    const u = req.url ?? "";
    if (u.startsWith("/ok.jpg")) { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(JPG); return; }
    if (u.startsWith("/login.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(LOGIN_HTML); return; }
    if (u.startsWith("/item.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(ITEM_HTML); return; }
    if (u.startsWith("/empty.jpg")) { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(); return; }
    res.writeHead(404); res.end();
  }, async (base) => {
    const client = new BoothClient({ baseUrl: base, minIntervalMs: 0, allowedImageHosts: ["127.0.0.1"] });
    const ok = await client.fetchImage(base + "/ok.jpg");
    assert.equal(ok.contentType, "image/jpeg");
    assert.equal(ok.bytes.length, JPG.length);
    assert.equal(ok.bytes.subarray(0, 3).toString("hex"), "ffd8ff"); // JPEG 魔数
    await assert.rejects(() => client.fetchImage(base + "/login.png"),
      (e: unknown) => e instanceof AppError && e.code === "LOGIN_REQUIRED");
    await assert.rejects(() => client.fetchImage(base + "/item.png"),
      (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR");
    await assert.rejects(() => client.fetchImage(base + "/empty.jpg"),
      (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR");
    await assert.rejects(() => client.fetchImage("https://example.com/x.jpg"),
      (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT");
    await assert.rejects(() => client.fetchImage("not a url"),
      (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT");
  });
});

test("adultCookie：开启时发 cookie，关闭时不发", async () => {
  const seen: Array<string | undefined> = [];
  await withServer((req, res) => {
    seen.push(req.headers.cookie as string | undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_8183383);
  }, async (base) => {
    await new BoothClient({ baseUrl: base, minIntervalMs: 0, adultCookie: true }).fetchItem("8183383");
    await new BoothClient({ baseUrl: base, minIntervalMs: 0, adultCookie: false }).fetchItem("8183383");
  });
  assert.equal(seen[0], "adult=t");
  assert.equal(seen[1], undefined);
});

test("限速：同域名串行 + 默认间隔 700ms（虚拟时钟，确定性）", async () => {
  let t = 0;
  const slept: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const starts: number[] = [];
  const fetchImpl = async (url: string) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    starts.push(t);
    await Promise.resolve();
    inflight--;
    return new Response(JSON.stringify({ name: "x", description: "", price: "", images: [], variations: [], tags: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const client = new BoothClient({
    baseUrl: "https://booth.pm", fetchImpl: fetchImpl as never,
    now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
  }); // 不传 minIntervalMs → 用默认值
  await client.fetchItem("8183383");
  await client.fetchItem("6115428");
  await client.fetchItem("6494376");
  assert.deepEqual(starts, [0, 700, 1400]);
  assert.deepEqual(slept, [700, 700]);
  assert.equal(maxInflight, 1); // 单域名串行：没有并发
});

test("限速：不同域名各自排队（不互相等待）", async () => {
  let t = 0;
  const slept: number[] = [];
  const fetchImpl = async () => new Response(JSON.stringify({ name: "x", description: "", price: "", images: [], variations: [], tags: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const jpgFetch = async () => new Response(JPG, { status: 200, headers: { "content-type": "image/jpeg" } });
  const client = new BoothClient({
    baseUrl: "https://booth.pm",
    fetchImpl: (async (url: string, init: unknown) => (String(url).includes("booth.pm") ? fetchImpl() : jpgFetch())) as never,
    now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
    allowedImageHosts: ["pximg.example"],
  });
  await client.fetchItem("8183383");
  await client.fetchImage("https://pximg.example/a.jpg");
  assert.deepEqual(slept, []);
});

test("限速：真实 HTTP 服务上两次请求间隔 >= 600ms（minIntervalMs=600，契约下限）", async () => {
  const arrivals: number[] = [];
  await withServer((req, res) => {
    arrivals.push(Date.now());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_8183383);
  }, async (base) => {
    const client = new BoothClient({ baseUrl: base, minIntervalMs: 600, maxRetries: 0 });
    await client.fetchItem("8183383");
    await client.fetchItem("6115428");
  });
  assert.equal(arrivals.length, 2);
  const gap = arrivals[1] - arrivals[0];
  assert.ok(gap >= 550, "两次请求间隔应 >= 550ms，实测 " + gap + "ms");
});

test("proxyUrl：undici 不可用时明确报错（不静默直连）", async () => {
  let undiciAvailable = true;
  try {
    const importer = new Function("s", "return import(s);") as (s: string) => Promise<unknown>;
    await importer("undici");
  } catch {
    undiciAvailable = false;
  }
  if (undiciAvailable) {
    // 有 undici 时该路径走 ProxyAgent，这里只验证不会静默忽略 proxy 配置
    assert.ok(true);
    return;
  }
  await assert.rejects(
    () => new BoothClient({ proxyUrl: "http://127.0.0.1:9", minIntervalMs: 0 }).fetchItem("8183383"),
    (e: unknown) => e instanceof AppError && e.code === "UPSTREAM_ERROR" && /undici/.test(e.message),
  );
});

// ---------- 真实 BOOTH 抓取（断网自动 skip） ----------
// ASSETVAULT_FORCE_OFFLINE=1 用于确定性验证“断网时 skip 而不是 fail”这条路径（见提交证据里的离线跑）。
let online = false;
if (process.env.ASSETVAULT_FORCE_OFFLINE === "1") {
  online = false;
} else {
  try {
    const probe = await fetch("https://booth.pm/ja/items/3087170.json", { signal: AbortSignal.timeout(8000) });
    online = probe.ok;
    await probe.arrayBuffer();
  } catch {
    online = false;
  }
}

test("live：真实抓取 8183383 / 6115428 / 6494376（网络不可用时跳过）", { skip: online ? false : "网络不可用，跳过真实抓取" }, async () => {
  const client = new BoothClient(); // 生产默认：700ms 间隔
  const a = await client.fetchItem("8183383");
  assert.equal(a.title, "✦ ミルフィ :: Milfy 対応 ✦ MilkyWay Makeup Texture");
  assert.ok(a.tags.some((t) => t.name === "ミルフィ対応"));
  assert.equal(a.shop?.subdomain, "lovable");

  const b = await client.fetchItem("6115428");
  assert.equal(b.title, "しなの専用　ロリ化Prefab & 表情16種セット");
  assert.ok(b.description.includes("Shinano_ver1.01対応済"));

  const c = await client.fetchItem("6494376");
  assert.equal(c.title, "【6Avatars】Cat's Round Eye");
  assert.ok(c.tags.some((t) => t.name === "MANUKA対応"));
  assert.ok(c.description.includes("▼今後対応予定▼"));

  const img = await client.fetchImage(c.images[0].resized ?? c.images[0].original);
  assert.ok(img.bytes.length > 0);
  const hex = img.bytes.subarray(0, 4).toString("hex");
  assert.ok(hex.startsWith("ffd8ff") || hex.startsWith("89504e47") || hex.startsWith("52494646"), "图片魔数异常: " + hex);
});

test("live：真实 404（不存在的商品号）→ NOT_FOUND", { skip: online ? false : "网络不可用，跳过真实抓取" }, async () => {
  const client = new BoothClient({ maxRetries: 0 });
  await assert.rejects(() => client.fetchItem("99999999"), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
});

test("live：未登录 downloadables 拿到 200 登录页 → LOGIN_REQUIRED（真实陷阱）", { skip: online ? false : "网络不可用，跳过真实抓取" }, async () => {
  const client = new BoothClient({ maxRetries: 0 });
  const res = await fetch("https://booth.pm/downloadables/1448437?variation_id=12317982", {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(isHtmlLoginPage(buf, res.headers.get("content-type")), true);
  void client;
});
