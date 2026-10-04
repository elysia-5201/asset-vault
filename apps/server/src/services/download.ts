import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

export interface ProtocolImport { itemId: string | null; dlUrl: string; fileName: string | null; orderId: string | null; variationId: string | null }

/** 解析 booth-library-manager://item-import?dlurl=...&downloadable_filename=...&item_id=... （与 BLM/ItemManager 同机制）。 */
export function parseProtocolUrl(raw: string): ProtocolImport | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "booth-library-manager:") return null;
  const q = u.searchParams;
  const dlUrl = q.get("dlurl") ?? q.get("download_url") ?? "";
  if (!dlUrl) return null;
  // 解析即校验：dlurl 必须是绝对 https 地址（真正的域名白名单由 isAllowedBoothUrl 在下载前把关）
  try { if (new URL(dlUrl).protocol !== "https:") return null; } catch { return null; }
  const itemId = q.get("item_id");
  return {
    itemId: itemId && /^[0-9]{1,12}$/.test(itemId) ? itemId : null,
    dlUrl,
    fileName: q.get("downloadable_filename") ?? q.get("filename") ?? null,
    orderId: q.get("order_id") ?? null,
    variationId: q.get("variation_id") ?? null,
  };
}

const ALLOWED_HOST = /(^|[.])booth[.]pm$/i;
export function isAllowedBoothUrl(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname); } catch { return false; }
}

export function sanitizeFileName(name: string): string {
  const leaf = String(name || "download").split(/[\\/]+/).pop() ?? "download";
  let base = basename(leaf).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "").trim();
  if (!base) base = "download";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.].*)?$/i.test(base)) base = "_" + base;
  return base.slice(0, 180);
}

function looksHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString("latin1").toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || head.trimStart().startsWith("<?xml");
}

export interface DownloadResult { path: string; bytes: number; fileName: string; finalUrl: string }

/**
 * 下载 BOOTH 文件到 destDir。逐跳校验域名必须是 *.booth.pm；拿到 HTML 登录页判为未登录并丢弃。
 * 落盘是原子的：先写 <name>.tmp，close 后 rename 到最终名；同名已存在则自动加序号（不覆盖）。
 */
export async function downloadBoothFile(opts: {
  dlUrl: string; destDir: string; fileName?: string | null; maxHops?: number; timeoutMs?: number; log?: (m: string) => void;
}): Promise<DownloadResult> {
  const { dlUrl, destDir } = opts;
  if (!isAllowedBoothUrl(dlUrl)) {
    throw Object.assign(new Error("只允许从 BOOTH 的 https 地址下载: " + String(dlUrl).slice(0, 80)), { code: "INVALID_INPUT", status: 400 });
  }
  const maxHops = opts.maxHops ?? 6;
  const timeoutMs = opts.timeoutMs ?? 120000;
  let url = dlUrl;
  let res: Response | null = null;
  let hops = 0;
  while (hops++ < maxHops) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "user-agent": "AssetVault/0.1 (local)" } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw Object.assign(new Error("重定向缺少 Location (HTTP " + r.status + ")"), { code: "UPSTREAM_ERROR", status: 502 });
        const next = new URL(loc, url).toString();
        if (!isAllowedBoothUrl(next)) throw Object.assign(new Error("重定向到非 BOOTH 域名，已拒绝: " + new URL(next).hostname), { code: "INVALID_INPUT", status: 400 });
        opts.log?.("download redirect " + r.status + " -> " + new URL(next).hostname);
        url = next;
        continue;
      }
      res = r;
      break;
    } finally { clearTimeout(timer); }
  }
  if (!res) throw Object.assign(new Error("重定向次数过多"), { code: "UPSTREAM_ERROR", status: 502 });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("BOOTH 下载链接已失效或需要登录（请回库存页重新点 DL）"), { code: "LOGIN_REQUIRED", status: 401 });
  if (!res.ok) throw Object.assign(new Error("下载失败 HTTP " + res.status), { code: "UPSTREAM_ERROR", status: 502 });
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const cd = res.headers.get("content-disposition") ?? "";
  const cdMatch = /filename[*]?=(?:UTF-8..|")?([^";]+)/i.exec(cd);
  const cdName = cdMatch ? cdMatch[1] : null;
  const fileName = sanitizeFileName(opts.fileName || cdName || basename(new URL(url).pathname) || "download.zip");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw Object.assign(new Error("下载内容为空"), { code: "UPSTREAM_ERROR", status: 502 });
  if (looksHtml(buf)) throw Object.assign(new Error("下载到的是登录页 HTML（未登录或链接已失效），已丢弃"), { code: "LOGIN_REQUIRED", status: 401 });
  mkdirSync(destDir, { recursive: true });
  const finalPath = join(destDir, fileName);
  let target = finalPath;
  if (existsSync(finalPath)) {
    const dot = finalPath.lastIndexOf(".");
    const stem = dot > 0 ? finalPath.slice(0, dot) : finalPath;
    const ext = dot > 0 ? finalPath.slice(dot) : "";
    for (let i = 1; i < 1000; i++) { const cand = stem + " (" + i + ")" + ext; if (!existsSync(cand)) { target = cand; break; } }
  }
  const tmp = target + ".tmp";
  const ws = createWriteStream(tmp);
  await new Promise<void>((resolve, reject) => { ws.on("error", reject); ws.end(buf, () => resolve()); });
  renameSync(tmp, target);
  const bytes = statSync(target).size;
  void ct;
  return { path: target, bytes, fileName: basename(target), finalUrl: url };
}

export function deleteQuietly(p: string): void { try { unlinkSync(p); } catch { /* ignore */ } }
