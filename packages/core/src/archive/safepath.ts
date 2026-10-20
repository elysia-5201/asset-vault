/**
 * 包内路径安全判定（core-content 所有）
 *
 * 用途：所有「包内条目名」在进 DB / 展示 / 未来落盘之前，统一过一遍这里。
 * 判定口径（与 ZIP Slip 的威胁面一致）：
 *   - NUL 字节                     → 拒绝（C 字符串截断，会绕过后续检查）
 *   - UNC（\\\\server\\share 或 //server/share） → 拒绝
 *   - 盘符（C: / C:/x / C:x）      → 拒绝
 *   - 绝对路径（/x）               → 拒绝
 *   - 任一段为 ".."                → 拒绝
 *   - 空名 / 只剩分隔符            → 拒绝
 * 其余按「相对路径」原样返回（反斜杠归一化成 "/"，去掉目录尾斜杠——这两步是列表层的既有口径）。
 *
 * 注意：这一层只做**字符串**判定，从不按路径落盘；真正落盘的地方（rar 解包）用的是
 * 序号文件名（见 archive/rar.ts 的 filenameTransform），所以这里不承担写盘安全。
 */
export interface SafePathOk { ok: true; path: string }
export interface SafePathRejected { ok: false; reason: string }
export type SafePathResult = SafePathOk | SafePathRejected;

export function safeEntryPath(name: string): SafePathResult {
  if (typeof name !== "string" || name.length === 0) return { ok: false, reason: "empty path" };
  if (name.includes("\u0000")) return { ok: false, reason: "NUL byte in path" };
  const slashed = name.replace(/\\/g, "/");
  if (slashed.startsWith("//")) return { ok: false, reason: "UNC path" };
  if (/^[A-Za-z]:/.test(slashed)) return { ok: false, reason: "drive-letter path" };
  if (slashed.startsWith("/")) return { ok: false, reason: "absolute path" };
  const path = slashed.replace(/\/+$/, "");
  if (path.length === 0) return { ok: false, reason: "empty path" };
  if (path.split("/").some((seg) => seg === "..")) return { ok: false, reason: "parent traversal (..)" };
  return { ok: true, path };
}
