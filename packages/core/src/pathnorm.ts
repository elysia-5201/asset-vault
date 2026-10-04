/**
 * pathnorm.ts — 路径归一化（core-identify）
 * 冻结签名见 docs/CONTRACT.md §4；本文件只做纯字符串运算，不触碰文件系统。
 */

/** Windows 扩展长度前缀。 */
const LONG_PREFIX = "\\\\?\\";
const LONG_UNC_PREFIX = "\\\\?\\UNC\\";

/** Windows MAX_PATH（含结尾 NUL 的预算）：长度 >= 260 时需要用 \\?\ 前缀绕过。 */
const MAX_PATH_LIMIT = 260;

/**
 * 归一化路径（DB 的 *_norm 列、去重、子路径比较都用它）：
 *  1. 反斜杠 → 正斜杠
 *  2. 去掉 Windows 长路径前缀 \\?\ / \\?\UNC\（UNC 还原成 //server/share）
 *  3. 折叠重复斜杠；UNC 的前导 // 保留
 *  4. NFC 归一化 + 统一小写（Windows 大小写不敏感语义）
 *  5. 去掉尾部斜杠（根路径 "/" 与盘符 "c:" 除外）
 * 注意：返回值不是可直接访问的路径（大小写已丢失），访问请用原始路径 + toWinLongPath。
 * 已知正例/反例对照：
 *   normalizePath("C:\\Games\\VRChat\\素材\\")  => "c:/games/vrchat/素材"
 *   normalizePath("\\\\?\\C:\\x")               => "c:/x"
 *   normalizePath("//Server/Share/A")          => "//server/share/a"
 *   normalizePath("C:\\")                      => "c:"
 */
export function normalizePath(p: string): string {
  if (typeof p !== "string") return "";
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("//?/UNC/")) s = "//" + s.slice(8);
  else if (s.startsWith("//?/")) s = s.slice(4);
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc && !s.startsWith("//")) s = "/" + s;
  s = s.normalize("NFC").toLowerCase();
  if (s.length > 1) {
    const trimmed = s.replace(/\/+$/, "");
    s = trimmed === "" ? "/" : trimmed;
  }
  return s;
}

/**
 * 需要时加 \\?\ 前缀（Windows 长路径）：
 *  - 已经是 \\?\ 前缀 → 原样返回（幂等）
 *  - 相对路径 → 原样返回（扩展前缀只对绝对路径有效）
 *  - 绝对路径（盘符或 UNC）且长度 >= 260 → 加前缀；UNC 用 \\?\UNC\
 * 正例/反例：259 字符绝对路径不加前缀；260 字符加前缀。分隔符统一成反斜杠。
 */
export function toWinLongPath(p: string): string {
  if (typeof p !== "string" || p === "") return p;
  const raw = p.replace(/\//g, "\\");
  if (raw.startsWith(LONG_PREFIX)) return raw;
  const isDriveAbs = /^[a-zA-Z]:\\/.test(raw);
  const isUncAbs = raw.startsWith("\\\\");
  if (raw.length < MAX_PATH_LIMIT || !(isDriveAbs || isUncAbs)) return raw;
  if (isUncAbs) return LONG_UNC_PREFIX + raw.slice(2);
  return LONG_PREFIX + raw;
}

/**
 * child 是否位于 parent 之下（含相等）。比较前两侧都归一化。
 * 反例：isSubPath("/a/bc", "/a/b") === false（不做裸前缀比较），isSubPath("/a/b", "/a/b") === true。
 */
export function isSubPath(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (p === "") return false;
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : p + "/";
  return c.startsWith(prefix);
}

/** 最后一个非空路径段（保留原大小写，用于显示/扩展名）；根路径返回 "/"，盘符根返回 "c:"。 */
export function basename(p: string): string {
  if (typeof p !== "string" || p === "") return "";
  const s = p.replace(/\\/g, "/");
  const parts = s.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (seg !== "") {
      if (/^[a-zA-Z]:$/.test(seg)) return seg.toLowerCase();
      return seg;
    }
  }
  return s.startsWith("/") ? "/" : "";
}

/**
 * 扩展名（含点，小写）；无扩展名返回 ""。点开头的隐藏文件（.gitignore）算无扩展名；
 * 多重扩展名只取最后一段：extOf("a.tar.gz") === ".gz"。
 */
export function extOf(p: string): string {
  const b = basename(p);
  if (b === "" || b === "/") return "";
  const i = b.lastIndexOf(".");
  if (i <= 0 || i === b.length - 1) return "";
  return b.slice(i).toLowerCase();
}
