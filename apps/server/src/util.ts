import { randomUUID, createHash } from "node:crypto";

export const now = (): string => new Date().toISOString();
export const uid = (): string => randomUUID();
export const sha256Text = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** FTS5 MATCH 安全引用：整体作为一个短语（trigram 下即子串匹配）。 */
export function ftsPhrase(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function toInt(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : dflt;
}
