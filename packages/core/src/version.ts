/**
 * 版本号解析与比较 —— 纯函数，无 IO、无副作用。
 *
 * 口径（冻结）：
 *  - 容许 `v`/`V` 前缀（GitHub tag 常见形态，如 `v0.2.0`），也容许前后空白；
 *  - `+` 之后是 build metadata，按 semver 语义**完全忽略**（`1.0.0+abc` == `1.0.0`）；
 *  - 版本主体是点分数字段：`1` / `1.2` / `1.2.3`；多于三段时多出来的段继续按数字逐段比较
 *    （缺的段补 0），因此 `1.2.3.4 > 1.2.3`、`1.2 == 1.2.0`；
 *  - `-` 之后是预发布标识（按 `.` 再分）。遵循 semver 第 11 条：数字段 < 非数字段，
 *    数字段按数值比、非数字段按 ASCII 字典序比；前缀相同则段数多者更大；
 *  - **预发布 < 正式**：`1.0.0-rc.1 < 1.0.0`；
 *  - 解析不了 → `parseVersion` 返回 `null`，`compareVersions` 抛错（由调用方兜底）。
 */

export interface ParsedVersion {
  /** 原始输入（未裁剪） */
  raw: string;
  /** 版本主体数字段，如 "1.2.3" → [1,2,3]、"1.2" → [1,2] */
  parts: number[];
  /** 预发布标识（`-` 之后按 `.` 分段）；空数组 = 正式版 */
  prerelease: string[];
  major: number;
  minor: number;
  patch: number;
}

const CORE_SEGMENT = /^[0-9]+$/;

/** 去掉 tag 上常见的 `v` 前缀（只在后面跟数字时才去，避免吃掉 `version` 这类词）。 */
export function stripVersionPrefix(input: string): string {
  return String(input).trim().replace(/^[vV](?=[0-9])/, "");
}

/** 解析版本字符串；无法解析返回 null（不抛错）。 */
export function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== "string") return null;
  const raw = input;
  let s = input.trim();
  if (!s) return null;

  s = stripVersionPrefix(s);
  if (!s) return null;

  // build metadata 忽略
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  if (!s) return null;

  const dash = s.indexOf("-");
  const coreText = dash >= 0 ? s.slice(0, dash) : s;
  const preText = dash >= 0 ? s.slice(dash + 1) : "";

  const segments = coreText.split(".");
  if (!segments.length) return null;
  const parts: number[] = [];
  for (const seg of segments) {
    if (!CORE_SEGMENT.test(seg)) return null;
    const n = Number(seg);
    if (!Number.isSafeInteger(n)) return null;
    parts.push(n);
  }

  let prerelease: string[] = [];
  if (dash >= 0) {
    // "1.0.0-"（空预发布）与 "1.0.0-a..b"（空标识）都视为非法
    if (!preText) return null;
    prerelease = preText.split(".");
    if (prerelease.some((p) => p.length === 0)) return null;
  }

  return {
    raw,
    parts,
    prerelease,
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
  };
}

const NUMERIC_ID = /^[0-9]+$/;

/** 比较两个预发布标识数组（两者都非空时调用）。 */
function comparePrerelease(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const xn = NUMERIC_ID.test(x);
    const yn = NUMERIC_ID.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;   // 数字标识 < 非数字标识
    if (x !== y) return x < y ? -1 : 1;  // ASCII 字典序
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;   // 前缀相同，段数多者更大
}

/**
 * 比较两个版本：a > b → 1，a < b → 0 之外为 -1，相等 → 0。
 * 任一版本无法解析时抛 Error（调用方自己 try/catch —— HTTP 层不允许把异常漏出去）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error("版本号无法解析：" + String(a));
  if (!pb) throw new Error("版本号无法解析：" + String(b));

  const n = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < n; i++) {
    const x = pa.parts[i] ?? 0;
    const y = pb.parts[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  const ax = pa.prerelease.length > 0;
  const bx = pb.prerelease.length > 0;
  if (!ax && !bx) return 0;
  if (!ax) return 1;    // 正式 > 预发布
  if (!bx) return -1;   // 预发布 < 正式
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
