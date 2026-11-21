/**
 * 全局导入：file-intake 纯逻辑（task-87 fix-r2；G6 H1/N2/F3）。
 *
 * 规则：
 * - 文件优先；没有 files 时只接管「合法绝对路径文本 / file URI」，普通文字与网页 URL 不接管。
 * - 可编辑区（input/textarea/contenteditable）不抢原生粘贴。
 * - 路径来源：deps.getPathForFile（桌面桥）→ File.path（旧 Electron）→ null（计 ignored，不伪造）。
 * - 草稿合并只追加、不重建：%DOWNLOADS%、相对路径、无效行原样保留（F1）。
 * - 去重：仅 Windows 盘符/UNC 大小写无关；POSIX 大小写敏感（F12）。
 * - 畸形 file URI 不抛（F9）。
 * - 草稿拆分（H1）：只有严格绝对路径进预检；%VAR%/相对路径/普通文字/畸形 URI 留在草稿并单独反馈。
 * - 批次身份（N2）：用单调 id，不用路径内容；消费按 id CAS。
 * - 异步协调（F3）：runGuarded 让取消/卸载后的迟到 resolve/reject/finally 都不写状态。
 * - 本模块不注册监听；卸载由 App 级薄组件负责。
 */

export interface IntakeDeps {
  getPathForFile?: (f: File) => string | null;
}

export interface IntakeResult {
  paths: string[];
  ignored: number;
  reason?: "editable" | "no-path";
}

export interface ArchiveDragEntry {
  assetId: number;
  entryPath: string;
  nested?: string;
}

declare global {
  interface Window {
    /** 浏览器和旧桌面版可能没有这些桌面接口。 */
    assetVaultDesktop?: {
      getPathForFile(file: File): string | null;
      chooseImportFolder?(defaultPath?: string): Promise<string | null>;
      prepareArchiveDrag?(entry: ArchiveDragEntry): Promise<{ token: string } | { error: string }>;
      startArchiveDrag?(token: string): Promise<{ ok: true } | { ok: false; error: string; retry?: boolean }>;
    };
  }
}

const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const UNC_RE = /^\\\\[^\\]+\\/;
const POSIX_RE = /^\/(?!\/)/;

/** 绝对路径归一：盘符 / UNC / POSIX / file URI；其它（普通文字、http URL）返回 null。畸形 URI 不抛。 */
export function normalizePath(raw: string): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    let rest: string;
    try {
      rest = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    } catch {
      return null;   // 畸形 URI（如 file://%zz）：不抛、不接管
    }
    if (/^\/[A-Za-z]:\//.test(rest)) return rest.slice(1);
    if (rest.startsWith("/")) return rest;
    return "//" + rest;
  }
  if (DRIVE_RE.test(s)) return s;
  if (UNC_RE.test(s)) return s;
  if (/^\/\//.test(s)) return s;
  if (POSIX_RE.test(s)) return s;
  return null;
}

/** 从拖拽/粘贴文本里只取合法绝对路径（按行/分号切、去引号）。 */
export function parsePathText(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/[\r\n]+/)) {
    for (const chunk of line.split(/\s*;\s*/)) {
      const p = normalizePath(chunk);
      if (p) out.push(p);
    }
  }
  return out;
}

/** 去重键：仅 Windows 盘符/UNC 大小写无关；POSIX 保持原样（F12）。 */
function pathKey(p: string): string {
  const win = DRIVE_RE.test(p) || UNC_RE.test(p) || /^\/\//.test(p);
  return win ? p.replace(/\//g, "\\").toLowerCase() : p;
}

/** 去重：保留首次出现顺序。 */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 把新路径并入既有草稿：**只追加、不重建**（F1）。
 * 原草稿（含 %DOWNLOADS%、相对路径、普通文字）逐字保留；新路径归一后按去重键追加。
 */
export function mergePathDraft(existing: string, incoming: string[]): string {
  const base = String(existing ?? "");
  const lines = base.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
  const seen = new Set(lines.map(pathKey));
  const add: string[] = [];
  for (const raw of incoming) {
    const p = normalizePath(raw);
    if (!p) continue;
    const k = pathKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    add.push(p);
  }
  if (add.length === 0) return base;
  if (lines.length === 0) return add.join("\n");
  return base.replace(/\s+$/, "") + "\n" + add.join("\n");
}

/** 草稿拆分结果：valid 只含严格绝对路径（可直接送预检）；invalid 保留原始行用于准确反馈。 */
export interface DraftSplit {
  valid: string[];
  invalid: string[];
}

/**
 * 拆分草稿（H1）：只把严格绝对路径交给预检，其余行原样留在草稿里并单独返回。
 * 与 util.splitPaths 的差别：不展开环境变量、不抛 URIError（畸形 file URI 归入 invalid）。
 */
export function splitDraftPaths(text: string): DraftSplit {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seenValid = new Set<string>();
  const seenInvalid = new Set<string>();
  for (const rawLine of String(text ?? "").split(/[\r\n]+/)) {
    for (const chunk of rawLine.split(/\s*;\s*/)) {
      let s = chunk.trim();
      if (!s || s.startsWith("#")) continue;
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
      if (!s) continue;
      const p = normalizePath(s);
      if (p) {
        const k = pathKey(p);
        if (!seenValid.has(k)) { seenValid.add(k); valid.push(p); }
      } else if (!seenInvalid.has(s)) {
        seenInvalid.add(s);
        invalid.push(s);
      }
    }
  }
  return { valid, invalid };
}

/** 可编辑区判定：input/textarea/select 或 contenteditable。 */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { tagName?: string; isContentEditable?: boolean }) | null;
  if (!el) return false;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/** 从 FileList 取绝对路径（桥优先 → File.path → null）；拖放/粘贴/文件选择共用。 */
export function pathsFromFileList(
  files: FileList | File[] | null | undefined,
  deps: IntakeDeps = {},
): { paths: string[]; ignored: number } {
  const out: string[] = [];
  let ignored = 0;
  for (const f of Array.from(files ?? [])) {
    const viaBridge = deps.getPathForFile?.(f) ?? null;
    const fallback = (f as File & { path?: string }).path ?? null;
    const p = normalizePath(viaBridge ?? fallback ?? "");
    if (p) out.push(p);
    else ignored += 1;
  }
  return { paths: out, ignored };
}

/**
 * 外部批次能否注入（F2）：预检中 / 提交中 / **已有待确认预检卡** 都拒绝，
 * 避免静默替换用户已勾选/跳过的批次。
 */
export function shouldAcceptExternalBatch(state: {
  prechecking: boolean;
  importing: boolean;
  pending: boolean;
}): boolean {
  return !state.prechecking && !state.importing && !state.pending;
}

/**
 * 预检在飞控制（F3）：begin 返回 generation；cancel 使在飞响应失效（真实可达的失效点）；
 * dispose 用于组件卸载——此后 begin 一律 null，且所有在飞 generation 立即失效。
 */
export interface PrecheckGate {
  begin: () => number | null;
  isCurrent: (gen: number) => boolean;
  end: (gen: number) => void;
  cancel: () => void;
  dispose: () => void;
  isBusy: () => boolean;
  isDisposed: () => boolean;
}

export function createPrecheckGate(): PrecheckGate {
  let gen = 0;
  let busy = false;
  let disposed = false;
  return {
    begin: () => {
      if (disposed || busy) return null;
      busy = true;
      gen += 1;
      return gen;
    },
    isCurrent: (g: number) => !disposed && g === gen,
    end: (g: number) => { if (!disposed && g === gen) busy = false; },
    cancel: () => { gen += 1; busy = false; },
    dispose: () => { disposed = true; gen += 1; busy = false; },
    isBusy: () => busy,
    isDisposed: () => disposed,
  };
}

/**
 * 一次挂载的 gate 生命周期（HB1）：setup 建 gate，cleanup 只 dispose **自己捕获的那个**。
 * 不能写成 cleanup 里 dispose ref 的当前值——StrictMode 的 setup→cleanup→setup 会先 dispose 掉
 * 第一次 setup 的 gate；若 cleanup 读 ref，就会误伤第二次 setup 刚装进去的新 gate。
 */
export interface GateLifecycle {
  gate: PrecheckGate;
  dispose: () => void;
}

export function createGateLifecycle(): GateLifecycle {
  const gate = createPrecheckGate();
  return { gate, dispose: () => gate.dispose() };
}

/** 外部批次（N2）：身份是单调 id，不是路径内容。 */
export interface ExternalBatch {
  id: number;
  paths: string[];
}

/** 取下一个未消费批次（N2）：按 id 单调推进，同内容的新批次仍会被处理。 */
export function pickNextBatch<T extends { id: number }>(queue: readonly T[], consumedId: number): T | null {
  for (const b of queue) if (b.id > consumedId) return b;
  return null;
}

export interface GuardedHandlers<T> {
  onValue: (v: T) => void;
  onError: (e: unknown) => void;
  onSettled: () => void;
}

/**
 * 真实异步协调（F3）：begin → 跑 task → 三路回调都先过 isCurrent。
 * 取消/卸载/被取代后，迟到的 resolve/reject/finally 一律不写状态。
 * 返回 generation；busy 时返回 null（调用方给忙碌反馈）。
 */
export function runGuarded<T>(
  gate: PrecheckGate,
  task: () => Promise<T>,
  handlers: GuardedHandlers<T>,
): number | null {
  const gen = gate.begin();
  if (gen === null) return null;
  const settle = () => {
    if (!gate.isCurrent(gen)) return;
    gate.end(gen);
    handlers.onSettled();
  };
  task().then(
    (v) => { if (gate.isCurrent(gen)) handlers.onValue(v); },
    (e) => { if (gate.isCurrent(gen)) handlers.onError(e); },
  ).then(settle, settle);
  return gen;
}

export function createFileIntake(deps: IntakeDeps): {
  handleDrop: (e: DragEvent) => IntakeResult;
  handlePaste: (e: ClipboardEvent) => IntakeResult;
} {
  const handleDrop = (e: DragEvent): IntakeResult => {
    if (isEditableTarget(e.target)) return { paths: [], ignored: 0, reason: "editable" };
    const dt = e.dataTransfer;
    const files = dt?.files;
    // m1：以 types 判定「外部文件拖动」——files 为空（虚拟 File / 浏览器未填充）也算，
    // 否则非面板区域仍会被浏览器导航走。内部自定义拖动不带 Files；文字/URL 走 text/plain。
    const hasFiles = Array.from(dt?.types ?? []).includes("Files") || (files?.length ?? 0) > 0;
    if (hasFiles) {
      // N3：外部 Files 一律阻止浏览器默认动作——无桥/虚拟 File/解析失败时，
      // 不 preventDefault 会让浏览器导航到该文件、把页面整个替换掉。
      e.preventDefault();
      if (files && files.length) {
        const r = pathsFromFileList(files, deps);
        const paths = dedupePaths(r.paths);
        if (paths.length) return { paths, ignored: r.ignored };
        return { paths: [], ignored: r.ignored, reason: "no-path" };
      }
      return { paths: [], ignored: 0, reason: "no-path" };
    }
    const paths = dedupePaths(parsePathText(dt?.getData?.("text/plain") ?? ""));
    if (paths.length) { e.preventDefault(); return { paths, ignored: 0 }; }
    return { paths: [], ignored: 0, reason: "no-path" };
  };

  const handlePaste = (e: ClipboardEvent): IntakeResult => {
    if (isEditableTarget(e.target)) return { paths: [], ignored: 0, reason: "editable" };
    const files = e.clipboardData?.files;
    if (files && files.length) {
      const r = pathsFromFileList(files, deps);
      const paths = dedupePaths(r.paths);
      if (paths.length) { e.preventDefault(); return { paths, ignored: r.ignored }; }
      return { paths: [], ignored: r.ignored, reason: "no-path" };
    }
    const paths = dedupePaths(parsePathText(e.clipboardData?.getData?.("text/plain") ?? ""));
    if (paths.length) { e.preventDefault(); return { paths, ignored: 0 }; }
    return { paths: [], ignored: 0, reason: "no-path" };
  };

  return { handleDrop, handlePaste };
}
