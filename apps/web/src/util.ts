/** 纯工具：格式化 / 路径解析 / 树构建。无副作用，便于自测。 */

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
}

export function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatYen(n: number | null | undefined, text?: string | null): string {
  if (text) return text;
  if (n === null || n === undefined) return "—";
  return "¥" + n.toLocaleString("ja-JP");
}

/** 解析 @avatar 语法：@Name / @"多 词 名" / @'x'；其余文本作为 q。中日文子串原样保留。 */
export function parseAtQuery(text: string): { q: string; avatars: string[] } {
  const avatars: string[] = [];
  const parts: string[] = [];
  const re = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
  let m: RegExpExecArray | null = null;
  let last = 0;
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(last, m.index));
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    if (v) avatars.push(v);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  return { q, avatars };
}

/** 把别名/名字匹配到 avatar id（大小写不敏感；NFKC 归一化以覆盖全角/半角）。 */
export function resolveAvatarNames(
  names: string[],
  avatars: { id: number; name: string; aliases: string[] }[],
): { ids: number[]; unresolved: string[] } {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const index = new Map<string, number>();
  for (const a of avatars) {
    index.set(norm(a.name), a.id);
    for (const al of a.aliases ?? []) index.set(norm(al), a.id);
  }
  const ids: number[] = [];
  const unresolved: string[] = [];
  for (const n of names) {
    const id = index.get(norm(n));
    if (id === undefined) unresolved.push(n); else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unresolved };
}

/** 从拖拽/粘贴文本中提取路径：支持换行、引号、file:// URI、uri-list。 */
export function splitPaths(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/[\r\n]+/)) {
    for (const chunk of rawLine.split(/\s*;\s*/)) {
      let s = chunk.trim();
      if (!s) continue;
      if (s.startsWith("#")) continue;
      if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
      s = uriToPath(s);
      if (s) out.push(s);
    }
  }
  return out;
}

export function uriToPath(s: string): string {
  let t = s.trim();
  if (/^file:\/\//i.test(t)) {
    t = decodeURIComponent(t.replace(/^file:\/\//i, ""));
    // /<drive>:/x → <drive>:/x ; /home/x → /home/x
    if (/^\/[A-Za-z]:\//.test(t)) t = t.slice(1);
  }
  return t.replace(/\//g, "/");
}

/** BOOTH 商品号粗提取（服务端 /booth/peek 仍是唯一事实来源）。 */
export function boothItemIdFromUrl(url: string): string | null {
  const m = /booth\.pm\/(?:[a-z]{2}\/)?(?:items|en\/items)\/(\d+)/i.exec(url);
  if (m) return m[1];
  const m2 = /booth\.pm\/.*?\/items\/(\d+)/i.exec(url);
  return m2 ? m2[1] : null;
}

export function looksLikeBoothUrl(s: string): boolean {
  return /booth\.pm\//i.test(s.trim());
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children: TreeNode[];
  fileCount: number;
  totalSize: number;
}

/** 由扁平 archive_entries 构建目录树（路径用 / 分隔）。 */
export function buildTree(entries: { path: string; size: number; isDir: boolean }[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, size: 0, children: [], fileCount: 0, totalSize: 0 };
  const dirs = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (p: string): TreeNode => {
    const hit = dirs.get(p);
    if (hit) return hit;
    const idx = p.lastIndexOf("/");
    const parent = ensureDir(idx < 0 ? "" : p.slice(0, idx));
    const node: TreeNode = { name: idx < 0 ? p : p.slice(idx + 1), path: p, isDir: true, size: 0, children: [], fileCount: 0, totalSize: 0 };
    parent.children.push(node);
    dirs.set(p, node);
    return node;
  };
  for (const e of entries) {
    const clean = e.path.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!clean) continue;
    if (e.isDir) { ensureDir(clean); continue; }
    const idx = clean.lastIndexOf("/");
    const parent = ensureDir(idx < 0 ? "" : clean.slice(0, idx));
    parent.children.push({ name: idx < 0 ? clean : clean.slice(idx + 1), path: clean, isDir: false, size: e.size, children: [], fileCount: 1, totalSize: e.size });
  }
  const roll = (n: TreeNode): void => {
    let files = 0; let size = 0;
    for (const c of n.children) {
      if (c.isDir) roll(c);
      files += c.fileCount; size += c.totalSize;
    }
    n.fileCount = files; n.totalSize = size;
    n.children.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "ja") : a.isDir ? -1 : 1));
  };
  roll(root);
  return root.children;
}

/** 树内按路径子串过滤（保留命中节点的祖先链）。 */
export function filterTree(nodes: TreeNode[], needle: string): TreeNode[] {
  const n = needle.trim().toLowerCase();
  if (!n) return nodes;
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      if (node.isDir) {
        const kids = walk(node.children);
        if (kids.length || node.path.toLowerCase().includes(n)) {
          out.push({ ...node, children: kids.length ? kids : node.children });
        }
      } else if (node.path.toLowerCase().includes(n)) {
        out.push(node);
      }
    }
    return out;
  };
  return walk(nodes);
}

export function extOf(p: string): string {
  const b = p.slice(p.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

export function isTextish(ext: string): boolean {
  return ["txt", "md", "json", "yml", "yaml", "csv", "xml", "html", "htm", "shader", "cs", "js", "ts", "meta", "pathname", "asset", "ini", "log", "prefab", "mat", "anim", "controller", "asmdef"].includes(ext);
}

export function isImageish(ext: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(ext);
}

export type Tone = "ok" | "warn" | "bad" | "busy" | "muted" | "violet" | "";

export function stateTone(state: string): Tone {
  if (state === "done") return "ok";
  if (state === "failed" || state === "abandoned") return "bad";
  if (state === "cancelled") return "muted";
  if (state === "paused") return "warn";
  return "busy";
}

export function px(n: number): string {
  return `${n}px`;
}
