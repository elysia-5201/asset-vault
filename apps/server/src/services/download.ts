import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { finished } from "node:stream/promises";
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

/** HTML 登录页判定只依赖有界前缀（256 字节），不需要也不允许把整个响应体读进内存。 */
const HTML_PREFIX_BYTES = 256;
function looksHtml(head: Uint8Array): boolean {
  const s = Buffer.from(head.subarray(0, HTML_PREFIX_BYTES)).toString("latin1").toLowerCase();
  return s.includes("<!doctype html") || s.includes("<html") || s.trimStart().startsWith("<?xml");
}

/** 实际落盘字节的默认硬上限（8 GiB）：与 hash 上限同量级，足够大文件，又不会无界。 */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** 整个下载（重定向 → body → 磁盘完成）的默认有限 deadline（120s），逐跳共享、不重置。 */
export const DEFAULT_DOWNLOAD_DEADLINE_MS = 120_000;

export interface DownloadResult { path: string; bytes: number; fileName: string; finalUrl: string }

export interface DownloadOptions {
  dlUrl: string; destDir: string; fileName?: string | null;
  /** 重定向跳数上限（默认 6） */
  maxHops?: number;
  /** 全流程 deadline 毫秒（默认 DEFAULT_DOWNLOAD_DEADLINE_MS）；从首个请求起跨重定向与 body 共享 */
  timeoutMs?: number;
  /** 实际流式字节硬上限（默认 DEFAULT_DOWNLOAD_MAX_BYTES）；覆盖值必须是正有限整数 */
  maxBytes?: number;
  log?: (m: string) => void;
}

const err = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });
const invalid = (message: string) => err(message, "INVALID_INPUT", 400);
const tooLarge = (got: number, cap: number) =>
  err("下载内容超过上限（实际已读 " + got + " 字节 > 上限 " + cap + " 字节），已中止并清理", "TOO_LARGE", 413);
const timedOut = (ms: number) =>
  err("下载超时（" + ms + "ms 内未完成，含重定向与落盘；已取消并清理）", "UPSTREAM_TIMEOUT", 504);

/**
 * 有界流式下载 BOOTH 文件到 destDir。
 * - 逐跳校验域名必须是 *.booth.pm（每次重定向都重新校验），跳数有上限。
 * - 实际字节硬上限：不信 Content-Length（仅用于提前拒绝），逐块累计超过即中止并清理。
 * - 一个有限的全局 deadline 覆盖「首个请求 → 所有重定向 → body → 磁盘写完」；stall 会被主动 abort。
 * - 先进唯一临时文件（destDir 内，同卷），完成后用 link 语义独占发布：绝不覆盖既有同名文件，
 *   竞争者在发布窗口抢先建成时自动改用带序号的新名字。硬链接不可用的文件系统回退到
 *   COPYFILE_EXCL（同样绝不覆盖；可见性从「原子」降级为「独占创建」，会在日志里说明）。
 * - 超限/断流/超时/HTTP 失败/HTML 登录页/写盘失败都会关闭句柄、取消 body、删除临时文件。
 */
export async function downloadBoothFile(opts: DownloadOptions): Promise<DownloadResult> {
  const { dlUrl, destDir } = opts;
  if (!isAllowedBoothUrl(dlUrl)) {
    throw invalid("只允许从 BOOTH 的 https 地址下载: " + String(dlUrl).slice(0, 80));
  }
  const maxHops = opts.maxHops ?? 6;
  const deadlineMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_DEADLINE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxHops) || maxHops <= 0) throw invalid("maxHops 必须是正有限整数");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalid("maxBytes 必须是正有限整数（默认 " + DEFAULT_DOWNLOAD_MAX_BYTES + "）");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw invalid("timeoutMs 必须是正有限整数（默认 " + DEFAULT_DOWNLOAD_DEADLINE_MS + "）");

  const ac = new AbortController();
  const deadlineAt = Date.now() + deadlineMs;
  const remainingMs = () => deadlineAt - Date.now();
  const timer = setTimeout(() => ac.abort(), deadlineMs);

  const cancelBody = async (r: Response | null) => {
    try { await r?.body?.cancel(); } catch { /* 已关闭/已消费，忽略 */ }
  };

  try {
    // ---------- 重定向（逐跳白名单 + 计数；deadline 不重置）----------
    let url = dlUrl;
    let res: Response | null = null;
    let hops = 0;
    while (hops++ < maxHops) {
      if (remainingMs() <= 0) throw timedOut(deadlineMs);
      let r: Response;
      try {
        r = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "user-agent": "AssetVault/0.1 (local)" } });
      } catch (e) {
        if (ac.signal.aborted) throw timedOut(deadlineMs);
        throw err("下载请求失败: " + String((e as Error)?.message ?? e).slice(0, 200), "UPSTREAM_ERROR", 502);
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        await cancelBody(r);
        if (!loc) throw err("重定向缺少 Location (HTTP " + r.status + ")", "UPSTREAM_ERROR", 502);
        const next = new URL(loc, url).toString();
        if (!isAllowedBoothUrl(next)) throw invalid("重定向到非 BOOTH 域名，已拒绝: " + new URL(next).hostname);
        opts.log?.("download redirect " + r.status + " -> " + new URL(next).hostname);
        url = next;
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw err("重定向次数过多", "UPSTREAM_ERROR", 502);
    if (ac.signal.aborted) { await cancelBody(res); throw timedOut(deadlineMs); }

    if (res.status === 401 || res.status === 403) {
      await cancelBody(res);
      throw err("BOOTH 下载链接已失效或需要登录（请回库存页重新点 DL）", "LOGIN_REQUIRED", 401);
    }
    if (!res.ok) {
      await cancelBody(res);
      throw err("下载失败 HTTP " + res.status, "UPSTREAM_ERROR", 502);
    }
    // Content-Length 只用于「提前」拒绝；缺失或造假都不影响下面的实际字节硬上限。
    const declaredLen = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      await cancelBody(res);
      throw tooLarge(declaredLen, maxBytes);
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const cdMatch = /filename[*]?=(?:UTF-8..|")?([^";]+)/i.exec(cd);
    const cdName = cdMatch ? cdMatch[1] : null;
    const fileName = sanitizeFileName(opts.fileName || cdName || basename(new URL(url).pathname) || "download.zip");

    const reader = res.body?.getReader();
    if (!reader) throw err("响应没有可读的 body", "UPSTREAM_ERROR", 502);

    fs.mkdirSync(destDir, { recursive: true });
    // 唯一临时文件放在目标目录内：同一文件系统，发布时可用 link 语义（跨设备 rename 会失败）。
    const tmp = join(destDir, ".av-dl-" + process.pid + "-" + randomBytes(8).toString("hex") + ".tmp");
    // 显式同步打开（wx = 独占新建）：避免 createWriteStream 的异步 open 在错误清理后
    // 才完成，从而产生「删除后又 open」的游离错误。
    let fd: number;
    try {
      fd = fs.openSync(tmp, "wx");
    } catch (e) {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      throw err("创建临时文件失败（" + String((e as NodeJS.ErrnoException)?.code ?? "") + "）", "UPSTREAM_ERROR", 502);
    }
    const ws = fs.createWriteStream(tmp, { fd, autoClose: true });
    ws.on("error", () => { /* 错误经 write 回调 / finished 统一上抛，这里只防未处理事件 */ });
    let written = 0;
    let prefixBuf = Buffer.alloc(0);

    /** 读一块，但把「永不返回的 stall」交给同一个全局 deadline 取消。 */
    const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; ac.signal.removeEventListener("abort", onAbort); fn(); } };
        const onAbort = () => finish(() => reject(timedOut(deadlineMs)));
        if (ac.signal.aborted) { onAbort(); return; }
        if (remainingMs() <= 0) { onAbort(); return; }
        ac.signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
          (v) => finish(() => resolve(v)),
          (e) => finish(() => reject(err("读取下载流失败: " + String((e as Error)?.message ?? e).slice(0, 200), "UPSTREAM_ERROR", 502))),
        );
      });

    try {
      for (;;) {
        if (remainingMs() <= 0) throw timedOut(deadlineMs);
        const { done, value } = await readChunk();
        if (done) break;
        const chunk = value;
        if (!chunk || chunk.byteLength === 0) continue;
        if (prefixBuf.length < HTML_PREFIX_BYTES) {
          prefixBuf = Buffer.concat([prefixBuf, Buffer.from(chunk.subarray(0, HTML_PREFIX_BYTES))]);
          if (looksHtml(prefixBuf)) {
            throw err("下载到的是登录页 HTML（未登录或链接已失效），已丢弃", "LOGIN_REQUIRED", 401);
          }
        }
        written += chunk.byteLength;
        if (written > maxBytes) throw tooLarge(written, maxBytes);
        // 背压：等这一块真正被内核接受（write 回调 / drain），而不是把整包塞进内存。
        await new Promise<void>((resolve, reject) => { ws.write(chunk, (e) => (e ? reject(e) : resolve())); });
      }
      if (written === 0) throw err("下载内容为空", "UPSTREAM_ERROR", 502);
      if (remainingMs() <= 0) throw timedOut(deadlineMs);
      ws.end();
      await finished(ws);
    } catch (e) {
      try { ws.destroy(); } catch { /* 忽略 */ }
      await finished(ws).catch(() => { /* 关句柄后再删文件（Windows 上打开的文件不能删） */ });
      try { await reader.cancel(); } catch { /* 已结束，忽略 */ }
      try { fs.unlinkSync(tmp); } catch { /* 还没建出来/已删除 */ }
      throw e;
    }

    // ---------- 发布：独占、不覆盖；失败也清理临时文件 ----------
    let target: string;
    try {
      target = publishExclusive(tmp, destDir, fileName, opts.log);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      throw e;
    }
    try { fs.unlinkSync(tmp); } catch { /* 已链接，tmp 仍在时尽力清理 */ }

    const bytes = fs.statSync(target).size;
    return { path: target, bytes, fileName: basename(target), finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

/** link() 在某些文件系统/平台不可用；这些错误码下用「独占创建」回退（仍然绝不覆盖）。 */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EACCES", "EMLINK"]);

/**
 * 原子非覆盖发布：
 *  - 先 link(tmp → 候选名)：目标已存在时内核返回 EEXIST，绝不会覆盖竞争赢家 → 换下一个候选名。
 *  - 硬链接不可用时回退 copyFileSync(src, cand, COPYFILE_EXCL)：同样是独占创建（EEXIST 表示被抢），
 *    只是可见性由「原子出现」降级为「独占创建」，会显式记日志，不做静默降级。
 */
function publishExclusive(tmp: string, destDir: string, fileName: string, log?: (m: string) => void): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const nameAt = (i: number) => (i === 0 ? fileName : stem + " (" + i + ")" + ext);
  let copyMode = false;
  for (let i = 0; i < 1000; i++) {
    const cand = join(destDir, nameAt(i));
    try {
      if (copyMode) {
        fs.copyFileSync(tmp, cand, fs.constants.COPYFILE_EXCL);
        return cand;
      }
      fs.linkSync(tmp, cand);
      return cand;
    } catch (e) {
      const code = String((e as NodeJS.ErrnoException)?.code ?? "");
      if (code === "EEXIST") continue; // 竞争赢家已占用该名字：换下一个候选，绝不覆盖
      if (!copyMode && LINK_UNSUPPORTED.has(code)) {
        copyMode = true;
        log?.("download publish: 硬链接不可用(" + code + ")，回退独占复制 COPYFILE_EXCL（仍绝不覆盖既有文件）");
        i--; // 同一候选名重试
        continue;
      }
      throw err("发布下载文件失败（" + code + "），已放弃且未覆盖任何既有文件", "UPSTREAM_ERROR", 502);
    }
  }
  throw err("同名文件过多，无法安全发布（不覆盖既有文件）", "UPSTREAM_ERROR", 502);
}

export function deleteQuietly(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }
