/**
 * risk.ts — 包内"可执行内容"风险扫描（纯函数：路径 → 风险，无 DB / 无 IO）
 *
 * 用途（v0.7.1 导入可靠性/安全）：Unity 包（.unitypackage 的 pathname、zip/7z/rar 的条目路径）
 * 里可能夹带脚本/程序集/本地库/编辑器代码/asmdef。本模块只做**字符串判定**，不做任何解压或执行，
 * 结果供后端决定"导入前提示/阻断"与 UI 风险面板展示。
 *
 * 判定规则（大小写不敏感、路径统一 \ → / 后再判）：
 *   .cs                                   → code（会被 Unity 编译执行）
 *   .dll                                  → assembly（托管程序集，可含任意代码）
 *   .so/.dylib/.bundle/.a                 → native（本地动态/静态库）
 *   <段>/Editor/<段> 下的 .cs             → editor_code（编辑器内执行）
 *   .asmdef / .asmref                     → asmdef（改变编译边界/程序集定义）
 *   其它扩展名（含伪装成 .cs.txt / .dll.txt 的）→ 不算风险，不猜
 *
 * 可选 magic 字节检测（task-56，惰性）：调用方若提供 opts.magic（返回前 ≤8 字节的 latin1 字符串），
 * 对**不是名字级风险**的扩展名再判"扩展名与实际内容是否矛盾"（task-56 规则）：
 *   PK（PK\x03\x04 / PK\x05\x06）且扩展名不在 zip/7z/rar/unitypackage/apk/jar/docx/xlsx/pptx → disguised
 *   MZ 且扩展名不是 exe/dll → disguised
 *   \x7fELF 且扩展名不是 so/elf → disguised
 *   gzip（1f 8b）且扩展名不是 gz/tgz/tar/unitypackage → disguised
 * 命中 type='disguised'、severity='warning'；读不到/太短/抛错/未知魔数 → 不判定（不猜）。
 * 不提供 magic 时行为与 task-50 完全一致（零额外调用、零 IO）。
 *
 * state 优先级：blocked（调用方显式规则）> unknown（扫描不完整/超预算/截断）> warning（有 warning 级命中）> clear。
 * 注意：asmdef 命中记 severity='info'，单独存在不升级为 warning —— 它是编译配置，不是可执行内容；
 * 若后端希望 asmdef 也告警，把 hits 的 severity 判据改一行即可（contract 不变）。
 *
 * 「扫描不完整」由调用方传 opts.incomplete=true（例如解析 partial / 超时 / 只扫了前 N 个条目）；
 * 本模块自身只在路径数或命中数超预算时置 truncated 并按 unknown 处理，绝不静默给出 clear。
 */
import { AppError } from "./contracts";

export type RiskState = "clear" | "warning" | "blocked" | "unknown";
export type RiskType = "code" | "assembly" | "native" | "editor_code" | "asmdef" | "disguised";
export type RiskSeverity = "info" | "warning";

export interface RiskHit { path: string; type: RiskType; reason: string; severity: RiskSeverity }

/** 从魔数识别出的"实际内容种类"（识别不出返回 null，不猜）。 */
export type MagicKind = "zip" | "pe" | "pdf" | "png" | "jpeg" | "gif" | "elf" | "gzip";

/** 魔数读取上限：所有判定只用到前 8 字节（jobs-dev 的读取器按这个给就够）。 */
export const RISK_MAGIC_MAX_BYTES = 8;

export interface ScanPathsOptions {
  /** 扫描不完整（解析 partial/超时/只扫了部分条目）→ state=unknown，不猜 clear */
  incomplete?: boolean;
  /** 调用方显式阻断规则（如"含 native 库一律阻断"）→ state=blocked */
  blockedReason?: string | null;
  /** 命中上限（默认 200），超过则截断并置 truncated（→ unknown） */
  maxHits?: number;
  /** 路径预算（默认 50000），超过则只扫前 N 条并置 truncated（→ unknown） */
  maxPaths?: number;
  /**
   * 可选：读取某路径的前 ≤8 字节，返回 **latin1 字符串**（task-56 契约；逐字节 0..255）。
   * 惰性：只对"不是名字级风险"的扩展名调用，且每条路径最多一次。
   * 返回 null/undefined 表示读不到 → 不判定；抛错按"读不到"处理，不让扫描失败。
   */
  magic?: (path: string) => string | null;
  /** 兼容别名（早先与 lead 沟通时用的名字）；同时给时 magic 优先。 */
  readMagic?: (path: string) => Uint8Array | ArrayBuffer | string | null | undefined;
}

export interface RiskScanResult {
  state: RiskState;
  hits: RiskHit[];
  /** 实际检查过的路径数（跳过空串/非字符串） */
  scanned: number;
  /** 结果被截断（命中超 200 或路径超预算） */
  truncated: boolean;
  /** 扫描器语义版本：规则/输出变化时 +1（缓存键与报告用） */
  scannerVersion: number;
  /** 仅在调用方显式给 blockedReason 时回填，便于 UI 显示"为什么阻断" */
  blockedReason?: string | null;
}

/** v2：新增可选 magic 字节检测（disguised）——可选能力也会改变输出，故 +1。 */
export const RISK_SCANNER_VERSION = 2;
export const DEFAULT_MAX_HITS = 200;
export const DEFAULT_MAX_PATHS = 50_000;

/** 扩展名 → 风险类型（大小写不敏感；未列出的不算风险）。 */
const EXT_RULES: Record<string, RiskType> = {
  cs: "code",
  dll: "assembly",
  so: "native",
  dylib: "native",
  bundle: "native",
  a: "native",
  asmdef: "asmdef",
  asmref: "asmdef",
};

/**
 * 魔数 → 该魔数下**可接受**的扩展名（task-56 规则；不在集合 = 伪装）。
 * 只对四类"容器/可执行"魔数做判定：PDF/PNG/JPEG/GIF 这类图片/文档魔数不参与，
 * 避免"photo.png 实际是 JPEG"这类无害改名被误报。
 * 注：gzip 的允许集合额外包含 unitypackage（它本身就是 gzip），否则每个 .unitypackage 都会被误报。
 */
const MAGIC_ALLOWED_EXT: Partial<Record<MagicKind, ReadonlySet<string>>> = {
  zip: new Set(["zip", "7z", "rar", "unitypackage", "apk", "jar", "docx", "xlsx", "pptx"]),
  pe: new Set(["exe", "dll"]),
  elf: new Set(["so", "elf"]),
  gzip: new Set(["gz", "tgz", "tar", "unitypackage"]),
};

const KIND_LABEL: Record<MagicKind, string> = {
  zip: "zip 容器（PK）", pe: "PE 可执行（MZ）", pdf: "PDF（%PDF）", png: "PNG", jpeg: "JPEG", gif: "GIF",
  elf: "ELF 可执行/共享库（\x7fELF）", gzip: "gzip 压缩流（1f 8b）",
};

function bytesOf(src: Uint8Array | ArrayBuffer | string): Uint8Array | null {
  if (typeof src === "string") {
    // latin1 字符串（逐字节 0..255）→ 字节数组；超出 255 的字符按低 8 位取
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
    return out;
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return null;
}

/**
 * 从前 ≤8 字节识别实际内容种类（纯函数，导出给测试/jobs-dev 复用）。
 * 识别不出返回 null（不猜），调用方据此选择"不判定"。
 */
export function magicKind(bytes: Uint8Array | ArrayBuffer | string | null | undefined): MagicKind | null {
  const b = bytes ? bytesOf(bytes) : null;
  if (!b || b.length < 2) return null;
  const at = (i: number) => b[i] ?? 0;
  if (at(0) === 0x50 && at(1) === 0x4b) return "zip"; // PK
  if (at(0) === 0x4d && at(1) === 0x5a) return "pe"; // MZ
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return "pdf"; // %PDF
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "gif"; // GIF8
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) return "elf"; // ELF
  if (at(0) === 0x1f && at(1) === 0x8b) return "gzip"; // 1f 8b
  return null;
}

const REASONS: Record<RiskType, string> = {
  code: ".cs 源码会随包进入 Unity 并参与编译（可执行）",
  assembly: ".dll 托管程序集，可能包含任意代码",
  native: "本地动态/静态库（.so/.dylib/.bundle/.a），可能绕过托管沙箱",
  editor_code: "Editor 目录下的 .cs 会在编辑器内执行（不受运行时剥离）",
  asmdef: ".asmdef/.asmref 会改变程序集与编译边界",
  disguised: "扩展名与实际内容不符（伪装文件）",
};

function severityOf(type: RiskType): RiskSeverity {
  return type === "asmdef" ? "info" : "warning";
}

/** 安全调用调用方的读取器：读不到/抛错一律当"不知道"，绝不让扫描失败。 */
function safeMagic(opts: ScanPathsOptions | undefined, path: string): Uint8Array | null {
  const reader = typeof opts?.magic === "function" ? opts.magic : opts?.readMagic;
  if (typeof reader !== "function") return null;
  try {
    const got = (reader as (p: string) => unknown)(path);
    if (got === null || got === undefined) return null;
    const b = bytesOf(got as Uint8Array | ArrayBuffer | string);
    return b && b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

/** 统一路径：\ → /、去首尾空白、压缩重复分隔符；返回用于判定的规范串（展示仍用原串）。 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
}

/** 最后一个 "." 之后的部分（小写）；无扩展名返回 ""。 */
function extOf(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 是否位于 Editor 目录（按路径段精确比较，大小写不敏感；MyEditor/Editorname 不算）。 */
function inEditorDir(p: string): boolean {
  return p.split("/").some((seg) => seg.toLowerCase() === "editor");
}

/**
 * 扫描一批路径（包内 pathname / 压缩包条目路径均可）。
 * 纯函数：不访问磁盘、不修改入参、同一输入恒等输出（结果已排序去重）。
 */
export function scanPaths(paths: string[], opts: ScanPathsOptions = {}): RiskScanResult {
  const maxHits = Number.isFinite(opts?.maxHits) && Number(opts.maxHits) > 0 ? Math.floor(Number(opts.maxHits)) : DEFAULT_MAX_HITS;
  const maxPaths = Number.isFinite(opts?.maxPaths) && Number(opts.maxPaths) > 0 ? Math.floor(Number(opts.maxPaths)) : DEFAULT_MAX_PATHS;
  const blockedReason = typeof opts?.blockedReason === "string" && opts.blockedReason.trim() !== "" ? opts.blockedReason.trim() : null;

  const list = Array.isArray(paths) ? paths : [];
  const seen = new Set<string>();
  const magicCache = new Map<string, Uint8Array | null>();
  const hits: RiskHit[] = [];
  let scanned = 0;
  let truncated = false;

  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const display = raw.trim();
    if (display === "") continue;
    if (scanned >= maxPaths) { truncated = true; break; }
    scanned++;

    const p = normalize(display);
    const ext = extOf(p);

    const push = (type: RiskType, reason: string): void => {
      const key = p.toLowerCase() + "|" + type;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ path: display, type, reason, severity: severityOf(type) });
    };

    // 1) 扩展名规则（未知扩展名不猜，但可能仍要做魔数判定，见 2）
    const type: RiskType | null = EXT_RULES[ext] ?? null;
    if (type) {
      const finalType: RiskType = type === "code" && inEditorDir(p) ? "editor_code" : type;
      push(finalType, REASONS[finalType]);
    }

    // 2) 可选魔数检测（task-56）：只对"不是名字级风险"的扩展名调用（惰性），魔数与扩展名矛盾才算命中
    if (!type) {
      // 每条路径最多读一次（同一文件的 / 与 \ 写法、重复条目都复用同一次读取）
      const cacheKey = p.toLowerCase();
      let raw: Uint8Array | null;
      if (magicCache.has(cacheKey)) raw = magicCache.get(cacheKey) ?? null;
      else { raw = safeMagic(opts, display); magicCache.set(cacheKey, raw); }
      const kind = magicKind(raw);
      const allowed = kind ? MAGIC_ALLOWED_EXT[kind] : undefined;
      if (kind && allowed && !allowed.has(ext)) {
        push("disguised", "扩展名与内容不符：" + (ext === "" ? "(无扩展名)" : "." + ext) + " 实际是 " + KIND_LABEL[kind]);
      }
    }
  }

  const sorted = hits.sort((a, b) => {
    const sev = (severityOf(b.type) === "warning" ? 1 : 0) - (severityOf(a.type) === "warning" ? 1 : 0);
    if (sev !== 0) return sev;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    const pa = a.path.toLowerCase();
    const pb = b.path.toLowerCase();
    return pa === pb ? 0 : pa < pb ? -1 : 1;
  });
  const limited = sorted.length > maxHits ? sorted.slice(0, maxHits) : sorted;
  if (sorted.length > maxHits) truncated = true;

  const state: RiskState = blockedReason !== null
    ? "blocked"
    : (opts?.incomplete === true || truncated)
      ? "unknown"
      : limited.some((h) => h.severity === "warning")
        ? "warning"
        : "clear";

  return {
    state,
    hits: limited,
    scanned,
    truncated,
    scannerVersion: RISK_SCANNER_VERSION,
    ...(blockedReason !== null ? { blockedReason } : {}),
  };
}

/** 便捷：只问"有没有可执行内容"（asmdef 不算）。UI/后端预检常用。 */
export function hasExecutableContent(result: RiskScanResult): boolean {
  return result.hits.some((h) => h.severity === "warning");
}

/** 便捷：把结果压成一行人类可读摘要（日志/提示用）。 */
export function summarizeRisk(result: RiskScanResult): string {
  if (result.state === "blocked") return "已阻断：" + (result.blockedReason ?? "按规则阻断");
  if (result.state === "unknown") return "风险未知：扫描不完整或超出预算（" + result.hits.length + " 条命中）";
  if (result.state === "clear") return "未发现可执行内容";
  const counts = new Map<RiskType, number>();
  for (const h of result.hits) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  return "发现可执行内容：" + [...counts.entries()].map(([t, n]) => t + "×" + n).join("、");
}

/** 参数校验工具（保留给调用方：明显非法的入参用同一错误形状）。 */
export function assertPathsArray(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths)) throw new AppError("INVALID_INPUT", "scanPaths: paths must be an array", 400);
}
