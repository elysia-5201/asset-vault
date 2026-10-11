/**
 * unitymeta.ts —— .meta 文本里的 GUID 解析 + 工程内路径过滤（纯函数，零 IO）。
 *
 * 为什么单独一个文件：判定"素材是不是真的被工程用到"时，两侧输入形状完全不同 ——
 *   · 素材侧：.unitypackage 里 <guid>/pathname 的 GUID 清单（见 core/unitypackage.ts）；
 *   · 工程侧：Assets/ 下每个 `<file>.meta` 里的 `guid: <32 位 hex>`。
 * 本文件只负责工程侧那一半，并且刻意保持纯函数（不碰文件系统、不依赖 Unity 编辑器），
 * 这样 GUID 口径可以单测钉死，而不是靠"跑一遍真实工程看看对不对"。
 */

/**
 * 从 .meta 文本里取 guid（YAML: "guid: 0123abcd…"）；取不到返回 null。
 *
 * 口径（冻结）：
 *  1. 只认**整行**形如 `guid: <32 位 hex>` 的字段（允许前导缩进、冒号两侧空白、行尾空白与 CRLF）；
 *     返回值**一律小写**——GUID 大小写不敏感，两侧集合求交必须落到同一个规范形式。
 *  2. 值必须是 32 位十六进制：31/33 位、含非 hex 字符（g-z、连字符、下划线…）→ null。
 *  3. 行内别处出现 "guid" 字样不会被误取：`m_Guid: x`、`# guid: …`、`guid_pool: …`、
 *     `SomeField: guid: …`、值后还有别的字符（`guid: <32hex> x`）都不算。
 *  4. 命中多行取**第一条**（Unity 正常只会有一个 guid 字段）。
 *
 * 正例：`"fileFormatVersion: 2\nguid: 0A1b2C3d4E5f60718293a4b5c6d7e8f9\n"` → `"0a1b2c3d4e5f60718293a4b5c6d7e8f9"`
 * 反例：`"someGuid: zzz\ntextureGuid: 123\n"` → null（没有行首的 guid 字段）
 */
export function parseMetaGuid(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const m = /^[ \t]*guid[ \t]*:[ \t]*([0-9a-fA-F]{32})[ \t]*\r?$/m.exec(text);
  if (!m || !m[1]) return null;
  return m[1].toLowerCase();
}

/** 扫描时要跳过的目录段（大小写不敏感）：Unity 的中转目录 + 版本库/依赖目录。 */
const SKIP_SEGMENTS = new Set(["library", "temp", "obj", "logs", ".git", ".svn", "node_modules"]);

/**
 * 从工程内相对路径判断是否是我们关心的资源（排除 Library/、Temp/、obj/、Packages/ 等）。
 *
 * 口径（冻结，只做**路径**过滤，不看文件类型 —— 类型由调用方决定）：
 *   · 只认 `Assets/` 开头的路径；正/反斜杠都行，可带 `./` 前缀，首段大小写不敏感
 *     （工程目录名在 Windows/macOS 上不区分大小写）；
 *   · 排除 `.meta` 自身（.meta 是导入记录，不是资源本体）；
 *   · 路径里出现 Library/Temp/obj/Logs/.git/.svn/node_modules 任何一段 → 排除；
 *   · 空串 / 非字符串 / 只有一段（`Assets`、`Assets/`）→ false。
 *
 * 正例：`Assets/Models/a.fbx` → true、`assets/x.png` → true；
 * 反例：`Library/x`、`Temp/x`、`Packages/com.x/y`、`Assets/x.png.meta`、`Assets` → false。
 */
export function isProjectAssetPath(relPath: string): boolean {
  if (typeof relPath !== "string") return false;
  let s = relPath.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "" || /\.meta$/i.test(s)) return false;
  const segs = s.split("/").filter((x) => x.length > 0);
  if (segs.length < 2) return false;
  if (segs[0].toLowerCase() !== "assets") return false;
  for (let i = 1; i < segs.length; i++) {
    if (SKIP_SEGMENTS.has(segs[i].toLowerCase())) return false;
  }
  return true;
}