/**
 * source/booth.ts — BOOTH 商品源（core-identify）
 * 冻结签名见 docs/CONTRACT.md §4。本机已验证事实（CONTRACT §5）：
 *  - https://booth.pm/ja/items/<id>.json 免登录可用（本文件 2026-10-04 用 8183383/6115428/6494376 复核）
 *  - /downloadables/<id> 未登录会 302 到 /users/sign_in，跟随后拿到 **HTTP 200 的登录页 HTML**（必须按魔数丢弃）
 *  - 404 是真正的 404 + text/html（BOOTH 的“找不到商品”页）
 *  - booth.pximg.net 图片免登录可下（JPEG 魔数 ff d8 ff）
 */

import { AppError } from "../contracts";
import type {
  BoothCategory, BoothDownloadableFile, BoothFetchOptions, BoothImage, BoothItemMeta,
  BoothShop, BoothTag, BoothVariation,
} from "../contracts";

/** 本文件 2026-10-04 实测可用的 UA（默认 UA 会被 Cloudflare 拦）。 */
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 20000;
/** 同一域名两次请求的最小间隔（CONTRACT §4：0.6~0.8s；取 0.7s）。 */
const DEFAULT_MIN_INTERVAL_MS = 700;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 600;
const MAX_BACKOFF_MS = 8000;
const DEFAULT_ALLOWED_IMAGE_HOSTS = ["booth.pximg.net", "booth.pm"];
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** BOOTH 老站点会把 shop 放在子域：<shop>.booth.pm；这些子域不是店铺。 */
const NON_SHOP_SUBDOMAINS = new Set(["www", "img", "image", "manage", "account", "help", "api", "static", "assets", "download"]);

type FetchInit = RequestInit & { dispatcher?: unknown };
type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/** BoothClient 的本地扩展参数（冻结接口只要求 BoothFetchOptions，这里全部是可选增量）。 */
export interface BoothClientExtras {
  /** 默认 https://booth.pm；测试可指向本地 HTTP 服务。 */
  baseUrl?: string;
  /** 5xx/429/网络错误的额外重试次数（默认 3 → 最多 4 次请求）。 */
  maxRetries?: number;
  /** 指数退避基数（默认 600ms → 600/1200/2400…）。 */
  backoffBaseMs?: number;
  /** 注入 fetch（测试/代理）；默认 globalThis.fetch。 */
  fetchImpl?: FetchLike;
  /** 注入 sleep（测试用虚拟时钟）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（配合 sleep 做确定性限速测试）。 */
  now?: () => number;
  /** fetchImage 允许的域名白名单（默认 booth.pximg.net / booth.pm）。 */
  allowedImageHosts?: string[];
  maxResponseBytes?: number;
}
export type BoothClientOptions = BoothFetchOptions & BoothClientExtras;

interface RawResponse {
  status: number;
  contentType: string | null;
  buf: Buffer;
  url: string;
}

function clampNum(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(max, Math.max(min, n));
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.name + ": " + e.message;
  return String(e);
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 字节魔数判型（登录页陷阱的第一道防线：图片/压缩包不可能同时是 HTML）。 */
function sniffKind(buf: Buffer): "html" | "json" | "image" | "archive" | "binary" | "text" | "unknown" {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return "unknown";
  const hex = buf.subarray(0, 16).toString("hex");
  const ascii = buf.subarray(0, 64).toString("latin1");
  if (hex.startsWith("ffd8ff")) return "image"; // JPEG
  if (hex.startsWith("89504e47")) return "image"; // PNG
  if (hex.startsWith("47494638")) return "image"; // GIF
  if (hex.startsWith("52494646") && ascii.slice(8, 12) === "WEBP") return "image";
  if (hex.startsWith("424d")) return "image"; // BMP
  if (hex.startsWith("49492a00") || hex.startsWith("4d4d002a")) return "image"; // TIFF
  if (hex.startsWith("504b0304") || hex.startsWith("504b0506") || hex.startsWith("504b0708")) return "archive"; // zip
  if (hex.startsWith("1f8b")) return "archive"; // gzip（.unitypackage 也是 gzip tar）
  if (hex.startsWith("526172211a07")) return "archive"; // rar
  if (hex.startsWith("377abcaf271c")) return "archive"; // 7z
  if (hex.startsWith("25504446")) return "binary"; // PDF
  if (hex.startsWith("1a45dfa3")) return "binary"; // EBML/mkv
  if (hex.startsWith("4d5a") || hex.startsWith("7f454c46")) return "binary"; // PE / ELF
  if (ascii.slice(4, 8) === "ftyp") return "binary"; // mp4/mov
  const head = stripBom(buf.subarray(0, 2048).toString("utf8")).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<?xml")) return "html";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (head === "") return "unknown";
  return "text";
}

/**
 * 是否是 BOOTH 登录页（“200 但其实是登录页”的陷阱）。
 * 判别规则（对真实样本固定，见 packages/core/test/identify/booth.test.ts）：
 *   +3 <title> 是登录字样（ログイン/Sign in/Log in）
 *   +2 <form action="…/users/sign_in…">
 *   +1 正文出现 /users/sign_in（商品页也有登录链接，故只给 1 分）
 *   +1 user_email / user[email] / session[…] 表单字段
 *   +2 <h1>ログイン</h1>
 *   -6 <meta property="og:type" content="product">（真实商品页硬反例）
 *   score >= 3 → true
 * 正例：真实登录页（HTTP 200, text/html）→ 6 分 → true。
 * 反例：真实商品页 https://booth.pm/ja/items/8183383（同样含 users/sign_in、authenticity_token）→ -5 → false。
 * 反例：JPEG/PNG/zip 等二进制魔数 → false（先判魔数，不看内容类型）。
 */
export function isHtmlLoginPage(buf: Buffer, contentType?: string | null): boolean {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const kind = sniffKind(buf);
  if (kind !== "html" && kind !== "text" && kind !== "unknown") return false;
  const ct = (contentType ?? "").toLowerCase();
  if (!ct.includes("html") && kind !== "html") return false;
  const head = stripBom(buf.subarray(0, 65536).toString("utf8"));
  let score = 0;
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(head);
  if (title && /(ログイン|サインイン|sign\s*in|log\s*in)/i.test(title[1])) score += 3;
  if (/<form[^>]+action=["'][^"']*\/users\/sign_in/i.test(head)) score += 2;
  if (/\/users\/sign_in/i.test(head)) score += 1;
  if (/(name=["']user\[email\]|id=["']user_email["']|name=["']session\[)/i.test(head)) score += 1;
  if (/<h1[^>]*>[^<]{0,40}(ログイン|サインイン)/i.test(head)) score += 2;
  const ogProductA = /<meta[^>]+property=["']og:type["'][^>]+content=["']product["']/i.test(head);
  const ogProductB = /<meta[^>]+content=["']product["'][^>]+property=["']og:type["']/i.test(head);
  if (ogProductA || ogProductB) score -= 6;
  return score >= 3;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseYen(priceText: string | null): number | null {
  if (!priceText) return null;
  const m = /(\d[\d,]*)/.exec(priceText);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? (v as any[]) : [];
}

/**
 * 解析 BOOTH 商品 URL / 裸商品号。
 * 支持：https://booth.pm/{locale}/items/<id>、https://booth.pm/items/<id>、
 *       https://<shop>.booth.pm/items/<id>、裸 "8183383"、带 .json / query / fragment / 尾斜杠。
 * canonicalUrl 一律 https://booth.pm/ja/items/<id>（稳定去重键）。
 * 明确拒绝：booth.pm/downloadables/<id>（downloadable id 与 item id 不是同一命名空间）、非 booth 域名。
 * 正例：parseBoothUrl("https://lovable.booth.pm/items/8183383?x=1") => { itemId: "8183383", canonicalUrl: "https://booth.pm/ja/items/8183383" }
 * 反例：parseBoothUrl("https://booth.pm/downloadables/1448437") => null
 */
export function parseBoothUrl(url: string): { itemId: string; canonicalUrl: string } | null {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (raw === "") return null;
  const canon = (id: string) => "https://booth.pm/ja/items/" + id;
  if (/^\d{5,9}$/.test(raw)) return { itemId: raw, canonicalUrl: canon(raw) };
  let u: URL;
  try {
    u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : "https://" + raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter((s) => s !== "");
  if (segs.includes("downloadables")) return null;
  if (host === "booth.pm") {
    // /[locale/]items/<id>
  } else if (host.endsWith(".booth.pm")) {
    const sub = host.slice(0, -".booth.pm".length);
    if (NON_SHOP_SUBDOMAINS.has(sub) || sub === "") return null;
  } else {
    return null;
  }
  const itemsIdx = segs.indexOf("items");
  if (itemsIdx === -1 || itemsIdx > 1) return null;
  const rawId = segs[itemsIdx + 1];
  if (!rawId) return null;
  const id = rawId.replace(/\.json$/i, "");
  if (!/^\d{5,9}$/.test(id)) return null;
  return { itemId: id, canonicalUrl: canon(id) };
}

function ensureOk(res: RawResponse): void {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 404) throw new AppError("NOT_FOUND", "BOOTH 商品不存在（HTTP 404）：" + res.url);
  if (res.status === 401 || res.status === 403) {
    throw new AppError("LOGIN_REQUIRED", "BOOTH 返回 HTTP " + res.status + "（需要登录/无权限）：" + res.url);
  }
  throw new AppError("UPSTREAM_ERROR", "BOOTH 返回 HTTP " + res.status + "：" + res.url);
}

function mapBoothItem(itemId: string, j: any): BoothItemMeta {
  const images: BoothImage[] = asArray(j?.images)
    .map((i) => ({
      original: String(i?.original ?? ""),
      resized: i?.resized ? String(i.resized) : undefined,
      caption: i?.caption ?? null,
    }))
    .filter((i) => i.original !== "");
  const variations: BoothVariation[] = asArray(j?.variations).map((v) => {
    const dl = v?.downloadable ?? {};
    const rawFiles = [...asArray(dl.no_musics), ...asArray(dl.musics)];
    const files: BoothDownloadableFile[] = rawFiles
      .map((f) => ({
        name: String(f?.name ?? f?.file_name ?? ""),
        file_name: f?.file_name ? String(f.file_name) : undefined,
        file_extension: f?.file_extension ? String(f.file_extension) : undefined,
        file_size: f?.file_size != null && String(f.file_size) !== "" ? String(f.file_size) : undefined,
        url: String(f?.url ?? ""),
      }))
      .filter((f) => f.name !== "" || f.url !== "");
    return { id: Number(v?.id ?? 0), price: Number(v?.price ?? 0), name: v?.name ?? null, files };
  });
  const tags: BoothTag[] = asArray(j?.tags)
    .map((t) => (typeof t === "string"
      ? { name: t }
      : { name: String(t?.name ?? ""), url: t?.url ? String(t.url) : undefined }))
    .filter((t) => t.name !== "");
  const shop: BoothShop | null = j?.shop
    ? { name: String(j.shop.name ?? ""), subdomain: String(j.shop.subdomain ?? "") }
    : null;
  const category: BoothCategory | null = j?.category
    ? {
      id: j.category.id != null ? Number(j.category.id) : undefined,
      name: String(j.category.name ?? ""),
      parent: j.category.parent ? { name: String(j.category.parent.name ?? "") } : null,
    }
    : null;
  const priceText = j?.price != null && String(j.price).trim() !== "" ? String(j.price) : null;
  return {
    itemId,
    title: String(j?.name ?? ""),
    description: String(j?.description ?? ""),
    priceText,
    priceYen: parseYen(priceText),
    publishedAt: j?.published_at ? String(j.published_at) : null,
    isAdult: Boolean(j?.is_adult),
    url: "https://booth.pm/ja/items/" + itemId,
    shop,
    tags,
    category,
    images,
    variations,
    raw: j,
  };
}

/**
 * BOOTH 客户端：同域名串行 + 最小间隔（默认 700ms，CONTRACT 要求 0.6~0.8s）+ 指数退避 + 超时 +
 * 可选代理（需要可选依赖 undici 的 ProxyAgent；缺失时明确报错而不是静默直连）+ 可选 adult cookie。
 * 所有失败都抛 AppError（code 与 api.md 对齐）：404 → NOT_FOUND；登录页/401/403 → LOGIN_REQUIRED；
 * 超时/非 JSON/5xx/网络错误 → UPSTREAM_ERROR。
 */
export class BoothClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly proxyUrl: string | null;
  private readonly adultCookie: boolean;
  private readonly minIntervalMs: number;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly allowedImageHosts: string[];
  private readonly maxResponseBytes: number;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();
  private dispatcherPromise: Promise<unknown> | null = null;

  constructor(opts: BoothFetchOptions = {}) {
    const o = (opts ?? {}) as BoothClientOptions;
    this.userAgent = o.userAgent && o.userAgent !== "" ? o.userAgent : DEFAULT_UA;
    this.timeoutMs = clampNum(o.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600000);
    this.proxyUrl = o.proxyUrl && o.proxyUrl !== "" ? o.proxyUrl : null;
    this.adultCookie = Boolean(o.adultCookie);
    this.minIntervalMs = clampNum(o.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, 0, 60000);
    this.baseUrl = (o.baseUrl && o.baseUrl !== "" ? o.baseUrl : "https://booth.pm").replace(/\/+$/, "");
    this.maxRetries = clampNum(o.maxRetries, DEFAULT_MAX_RETRIES, 0, 10);
    this.backoffBaseMs = clampNum(o.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, 0, 60000);
    this.fetchImpl = o.fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => Date.now());
    this.allowedImageHosts = o.allowedImageHosts && o.allowedImageHosts.length > 0
      ? o.allowedImageHosts.map((h) => h.toLowerCase())
      : DEFAULT_ALLOWED_IMAGE_HOSTS;
    this.maxResponseBytes = clampNum(o.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 1024 * 1024 * 1024);
  }

  /** 同域名串行 + 间隔节流（每个请求都过这道闸；不同域名各有队列）。 */
  private enqueue<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const last = this.lastStart.get(host);
      const wait = last === undefined ? 0 : last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart.set(host, this.now());
      return fn();
    });
    this.queues.set(host, next.then(() => undefined, () => undefined));
    return next;
  }

  private async dispatcher(): Promise<unknown | undefined> {
    if (!this.proxyUrl) return undefined;
    if (!this.dispatcherPromise) {
      const proxy = this.proxyUrl;
      this.dispatcherPromise = (async () => {
        const importer = new Function("s", "return import(s);") as (s: string) => Promise<any>;
        let mod: any;
        try {
          mod = await importer("undici");
        } catch {
          throw new AppError("UPSTREAM_ERROR",
            "已设置 proxyUrl 但可选依赖 undici 未安装（无法构造 ProxyAgent）；请 npm i undici 或通过 fetchImpl 注入自带代理的 fetch：" + proxy);
        }
        if (!mod || typeof mod.ProxyAgent !== "function") {
          throw new AppError("UPSTREAM_ERROR", "undici 已安装但没有 ProxyAgent 导出，无法使用 proxyUrl：" + proxy);
        }
        return new mod.ProxyAgent(proxy);
      })();
    }
    return this.dispatcherPromise;
  }

  private async attempt(url: string, accept: string, dispatcher: unknown): Promise<RawResponse> {
    return this.enqueue(hostOf(url), async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = new Headers();
        headers.set("user-agent", this.userAgent);
        headers.set("accept", accept);
        headers.set("accept-language", "ja,en;q=0.8");
        if (this.adultCookie) headers.set("cookie", "adult=t");
        const init: FetchInit = { headers, signal: controller.signal, redirect: "follow" };
        if (dispatcher) init.dispatcher = dispatcher;
        const res = await this.fetchImpl(url, init);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > this.maxResponseBytes) {
          throw new AppError("UPSTREAM_ERROR", "BOOTH 响应体过大（" + buf.length + " bytes）：" + url);
        }
        return { status: res.status, contentType: res.headers.get("content-type"), buf, url };
      } catch (e) {
        if (controller.signal.aborted) {
          throw new AppError("UPSTREAM_ERROR", "BOOTH 请求超时（" + this.timeoutMs + "ms）：" + url);
        }
        if (e instanceof AppError) throw e;
        throw new AppError("UPSTREAM_ERROR", "BOOTH 请求失败：" + errMessage(e) + "（" + url + "）");
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** 带退避重试的请求（429/5xx/网络错误/超时重试；4xx 直接抛出）。 */
  private async request(url: string, accept: string): Promise<RawResponse> {
    const dispatcher = await this.dispatcher();
    let lastErr: unknown = null;
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        const res = await this.attempt(url, accept, dispatcher);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new AppError("UPSTREAM_ERROR", "BOOTH 返回 HTTP " + res.status + "：" + url);
          if (i < this.maxRetries) {
            await this.sleep(Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * Math.pow(2, i)));
            continue;
          }
          throw lastErr;
        }
        return res;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof AppError && e.code === "UPSTREAM_ERROR";
        if (!retryable || i >= this.maxRetries) throw e;
        await this.sleep(Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * Math.pow(2, i)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new AppError("UPSTREAM_ERROR", "BOOTH 请求失败：" + url);
  }

  /** GET https://booth.pm/ja/items/<id>.json → BoothItemMeta（404/登录页/非 JSON/超时都有明确错误）。 */
  async fetchItem(itemId: string): Promise<BoothItemMeta> {
    const id = typeof itemId === "string" ? itemId.trim() : String(itemId ?? "").trim();
    if (!/^\d{5,9}$/.test(id)) throw new AppError("INVALID_INPUT", "非法 BOOTH 商品号：" + String(itemId));
    const url = this.baseUrl + "/ja/items/" + id + ".json";
    const res = await this.request(url, "application/json");
    ensureOk(res);
    const ct = (res.contentType ?? "").toLowerCase();
    const kind = sniffKind(res.buf);
    // 登录页陷阱优先判定（服务端可能谎报 application/json，必须按内容判）
    if (isHtmlLoginPage(res.buf, res.contentType)) {
      throw new AppError("LOGIN_REQUIRED", "BOOTH 返回登录页而不是商品 JSON（需要登录/成人确认？）：" + url);
    }
    if (!ct.includes("json") && kind !== "json") {
      throw new AppError("UPSTREAM_ERROR", "BOOTH 商品 " + id + " 返回了非 JSON 内容（content-type=" + (res.contentType ?? "?") + "）：" + url);
    }
    let json: any;
    try {
      json = JSON.parse(res.buf.toString("utf8"));
    } catch (e) {
      throw new AppError("UPSTREAM_ERROR", "BOOTH 商品 JSON 解析失败：" + errMessage(e) + "（" + url + "）");
    }
    return mapBoothItem(id, json);
  }

  /** 下载图片（仅白名单域名）；返回 HTML（含登录页）一律报错，绝不把 HTML 当图片写盘。 */
  async fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    if (typeof url !== "string" || url.trim() === "") throw new AppError("INVALID_INPUT", "图片 URL 为空");
    const target = url.trim();
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new AppError("INVALID_INPUT", "非法图片 URL：" + target);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new AppError("INVALID_INPUT", "图片 URL 协议不支持：" + target);
    }
    const host = u.hostname.toLowerCase();
    const allowed = this.allowedImageHosts.some((a) => host === a || host.endsWith("." + a));
    if (!allowed) {
      throw new AppError("INVALID_INPUT", "图片域名不在白名单（" + this.allowedImageHosts.join(", ") + "）：" + host);
    }
    const res = await this.request(target, "image/*");
    ensureOk(res);
    const ct = res.contentType;
    const kind = sniffKind(res.buf);
    if (res.buf.length === 0) throw new AppError("UPSTREAM_ERROR", "BOOTH 图片响应为空：" + target);
    if (isHtmlLoginPage(res.buf, ct)) {
      throw new AppError("LOGIN_REQUIRED", "BOOTH 返回登录页而不是图片（200 陷阱）：" + target);
    }
    if (kind === "html" || (ct ?? "").toLowerCase().includes("html")) {
      throw new AppError("UPSTREAM_ERROR", "BOOTH 返回 HTML 而不是图片（content-type=" + (ct ?? "?") + "）：" + target);
    }
    return { bytes: res.buf, contentType: ct };
  }
}
