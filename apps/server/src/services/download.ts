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
/**
 * 整条下载（请求 → 重定向 → body 读写 → 收尾 → 发布前后）共享的默认有限 deadline（30 分钟），逐跳不重置。
 * 它与字节上限是两个**独立**边界：上限管"多大"，deadline 管"挂多久"。30 分钟只用于兜住病态的
 * 无进展挂起（stall），不是任何真实带宽/大文件场景下的吞吐保证，也未在真实 BOOTH 上实测。
 */
export const DEFAULT_DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000;
/**
 * 错误路径清理的**共享**预算上限：一次失败里的 finished(close) 与 reader/body cancel 一起花这份时间，
 * 而不是各自拿一份（否则 2s + 2s 累加）。即使取消/close 再也不回调，清理本身也不能永挂。
 */
const CLEANUP_WAIT_MS = 2000;

export interface DownloadResult { path: string; bytes: number; fileName: string; finalUrl: string }

export interface DownloadOptions {
  dlUrl: string; destDir: string; fileName?: string | null;
  /** 重定向跳数上限（默认 6） */
  maxHops?: number;
  /** 全流程 deadline 毫秒（默认 DEFAULT_DOWNLOAD_DEADLINE_MS）；从首个请求起跨重定向、body 读写、收尾与发布前后共享，逐跳不重置 */
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
  err("下载超时（" + ms + "ms 内未完成，含重定向、读写与落盘；已取消并清理）", "UPSTREAM_TIMEOUT", 504);

/** 诊断统一脱敏：不出现下载 URL，也不出现签名/令牌类 query（错误文本同样不得外泄凭据）。 */
function redactDiagnostic(text: string): string {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/\b(token|signature|sig|key|expires|auth)=[^\s&"'<>]+/gi, "$1=<redacted>");
}

/** 清理等待有上限：即使流/句柄再也不回调，也不能让清理本身永挂。 */
function waitBounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let t: NodeJS.Timeout | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      resolve();
    };
    t = setTimeout(finish, ms);
    p.then(finish, finish);
  });
}

/**
 * 有界流式下载 BOOTH 文件到 destDir。
 * - 逐跳校验域名必须是 *.booth.pm（每次重定向都重新校验），跳数有上限。
 * - 实际字节硬上限：不信 Content-Length（仅用于提前拒绝），逐块累计超过即中止并清理。
 * - 一个有限的全局 deadline 覆盖「首个请求 → 所有重定向 → body 读取 → 写回调 → 收尾 → 发布前后」；
 *   每个等待都与 abort 竞速，stall（含写回调/收尾永不回调）会被主动打断。限制（如实记录）：同步系统调用
 *   （link/stat）无法被 timer 抢占，发布前后按绝对时间复查，越过 deadline 的发布会被撤销并报超时，绝不返回晚到的成功。
 * - 先进唯一临时文件（destDir 内，同卷），完成后只用 link 语义独占发布：绝不覆盖既有同名文件，
 *   竞争者在发布窗口抢先建成时自动改用带序号的新名字。硬链接不可用（EPERM/ENOTSUP/EXDEV…）时
 *   **fail-closed**：明确报错，不复制、不 rename、不产生任何终名。
 * - 超限/断流/超时/HTTP 失败/HTML 登录页/写盘失败都会关闭句柄、取消 body（redirect/HTTP 失败等早期分支同样走
 *   公共 cancelBody）、删除临时文件；所有清理等待共享一份有限预算（CLEANUP_WAIT_MS），句柄永不 close 或
 *   cancel 永不 settle 也不会永挂，且仍然会继续 unlink 临时文件。
 * - 收尾只做 flush + close，**不执行 fsync**：不宣称也不提供掉电持久化保证（进程崩溃/断电可能丢已写数据）。
 */
export async function downloadBoothFile(opts: DownloadOptions): Promise<DownloadResult> {
  const { dlUrl, destDir } = opts;
  if (!isAllowedBoothUrl(dlUrl)) {
    // 不回显 dlUrl：BOOTH 签名 query 属于凭据，错误文本一律不含 URL。
    throw invalid("只允许从 BOOTH 的 https 地址下载");
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

  // 清理共享预算：从第一次清理等待开始计时，后续等待只能用剩下的时间。
  // 不用 unref 定时器：清理定时器必须在没有任何其它 handle 时也能让 Promise 结算，
  // 否则调用方会看到一个永远 pending 的 rejection。
  let cleanupDeadlineAt: number | null = null;
  const cleanupBudgetMs = () => {
    if (cleanupDeadlineAt === null) cleanupDeadlineAt = Date.now() + CLEANUP_WAIT_MS;
    return Math.max(0, cleanupDeadlineAt - Date.now());
  };
  /** 任何清理等待都用剩余预算包一层：底层永不 settle 也一定在有限时间内返回（不抛错）。 */
  const boundedCleanup = (p: Promise<unknown>) => waitBounded(p, cleanupBudgetMs());

  /**
   * 取消响应体：redirect/HTTP 失败/长度预拒/流内异常等所有路径共用。
   * body.cancel() 在 undici 或自定义流上可能永不 settle，因此必须走同一份有限预算；
   * 取消失败也不影响后续清理（unlink tmp）。
   */
  const cancelBody = async (r: Response | null) => {
    try {
      const body = r?.body;
      if (body) await boundedCleanup(body.cancel());
    } catch { /* 已关闭/已消费/取消失败，忽略 */ }
  };

  /** 把任意等待（读/写回调/收尾）与同一个全局 deadline 竞速；abort 一到立即结束，且不残留监听器。 */
  const raceDeadline = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let onAbort: () => void;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        ac.signal.removeEventListener("abort", onAbort);
        fn();
      };
      onAbort = () => settle(() => reject(timedOut(deadlineMs)));
      // 先挂 handler：无论 deadline 先到还是底层先结算，都不会留下未处理的 rejection。
      p.then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)));
      if (ac.signal.aborted || remainingMs() <= 0) onAbort();
      else ac.signal.addEventListener("abort", onAbort, { once: true });
    });

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
        throw err("下载请求失败: " + redactDiagnostic(String((e as Error)?.message ?? e)).slice(0, 200), "UPSTREAM_ERROR", 502);
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
      try { await boundedCleanup(reader.cancel()); } catch { /* 忽略 */ }
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
          (e) => finish(() => reject(err("读取下载流失败: " + redactDiagnostic(String((e as Error)?.message ?? e)).slice(0, 200), "UPSTREAM_ERROR", 502))),
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
        // 同一个全局 deadline 也竞速进这次等待：磁盘侧永不回调时不会无限挂起。
        await raceDeadline(new Promise<void>((resolve, reject) => {
          ws.write(chunk, (e?: Error | null) => (e ? reject(e) : resolve()));
        }));
      }
      if (written === 0) throw err("下载内容为空", "UPSTREAM_ERROR", 502);
      if (remainingMs() <= 0) throw timedOut(deadlineMs);
      ws.end();
      // 收尾（flush/close）同样受 deadline 约束：正常回调即返回，卡死则被 abort 打断。
      // 注意：这里**没有 fsync**，只是把数据 flush 给内核并关闭句柄；因此不提供掉电持久化保证。
      await raceDeadline(finished(ws));
    } catch (e) {
      try { ws.destroy(); } catch { /* 忽略 */ }
      try {
        // 关闭句柄与取消读流共用同一份有限预算：close 永不回调、cancel 永不 settle 都不会永挂。
        // finished 的 rejection 在此消化（关句柄失败不影响后面删文件；Windows 上打开的文件不能删）。
        await waitBounded(finished(ws).catch(() => { /* 关句柄后再删文件（Windows 上打开的文件不能删） */ }), cleanupBudgetMs());
        try { await boundedCleanup(reader.cancel()); } catch { /* 已结束，忽略 */ }
      } finally {
        // 无论取消/close 是否成功，都继续清理临时文件。
        try { fs.unlinkSync(tmp); } catch { /* 还没建出来/已删除 */ }
      }
      throw e;
    }

    // ---------- 发布：独占、不覆盖；失败也清理临时文件 ----------
    // 同步系统调用（link/stat）无法被 timer 抢占：发布前按绝对时间复查，发布后再复查一次；
    // 一旦越过 deadline 就撤销自己刚独占发布的成品并报超时，绝不返回「晚到的成功」。
    if (remainingMs() <= 0) throw timedOut(deadlineMs);
    let target: string;
    try {
      target = publishExclusive(tmp, destDir, fileName, opts.log);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      throw e;
    }
    let bytes: number;
    try {
      bytes = fs.statSync(target).size;
    } catch (e) {
      deleteQuietly(target);
      deleteQuietly(tmp);
      throw err("发布后校验失败（" + String((e as NodeJS.ErrnoException)?.code ?? "") + "），已撤销成品", "UPSTREAM_ERROR", 502);
    }
    if (remainingMs() <= 0) {
      // 发布窗口内越过 deadline：撤销只由自己独占创建的那个名字，不留部分交付。
      deleteQuietly(target);
      deleteQuietly(tmp);
      throw timedOut(deadlineMs);
    }
    try { fs.unlinkSync(tmp); } catch { /* 已链接，tmp 仍在时尽力清理 */ }
    return { path: target, bytes, fileName: basename(target), finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

/** 目标文件系统不支持硬链接的错误码：这些情况下 fail-closed（明确失败），绝不降级复制/rename。 */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EACCES", "EMLINK"]);

/**
 * 独占非覆盖发布：只用 link(tmp → 候选名)。
 *  - 目标已存在 ⇒ 内核 EEXIST ⇒ 换下一个候选名；不存在 check-then-rename 覆盖窗口，绝不覆盖竞争赢家。
 *  - 文件系统不支持硬链接（EPERM/ENOTSUP/EXDEV/ENOSYS/EACCES/EMLINK）⇒ **fail-closed**：
 *    明确报错，不复制、不 rename、不产生任何终名（临时文件由调用方删除）。
 *    已删除 copyFileSync 回退：它同步复制整包（阻塞事件循环、deadline 失效），且复制中途失败会
 *    在终名下留下部分成品，还可能让其它进程读到截断内容。
 */
function publishExclusive(tmp: string, destDir: string, fileName: string, log?: (m: string) => void): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const nameAt = (i: number) => (i === 0 ? fileName : stem + " (" + i + ")" + ext);
  for (let i = 0; i < 1000; i++) {
    const cand = join(destDir, nameAt(i));
    try {
      fs.linkSync(tmp, cand);
      return cand;
    } catch (e) {
      const code = String((e as NodeJS.ErrnoException)?.code ?? "");
      if (code === "EEXIST") continue; // 竞争赢家已占用该名字：换下一个候选，绝不覆盖
      if (LINK_UNSUPPORTED.has(code)) {
        log?.("download publish: 目标文件系统不支持硬链接(" + code + ")，fail-closed 放弃发布（不复制、不覆盖）");
        throw err("目标文件系统不支持硬链接（" + code + "），已放弃发布且未产生任何终名", "UPSTREAM_ERROR", 502);
      }
      throw err("发布下载文件失败（" + code + "），已放弃且未覆盖任何既有文件", "UPSTREAM_ERROR", 502);
    }
  }
  throw err("同名文件过多，无法安全发布（不覆盖既有文件）", "UPSTREAM_ERROR", 502);
}

export function deleteQuietly(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }
