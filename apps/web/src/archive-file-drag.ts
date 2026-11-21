import { useEffect, useRef, type DragEvent, type HTMLAttributes } from "react";
import type { ArchiveDragEntry } from "./file-intake";

type DragBridge = NonNullable<Window["assetVaultDesktop"]>;
type Prepared = { token: string; expiresAt: number };
type PrepareResult = { token: string } | { error: string };

let nativeDragActive = false;
export function isArchiveDragActive(): boolean { return nativeDragActive; }

export function useArchiveFileDrag(assetId: number, enabled: boolean, onToast: (kind: "ok" | "bad" | "info", text: string) => void) {
  const bridge: DragBridge | undefined = typeof window === "undefined" ? undefined : window.assetVaultDesktop;
  const supported = enabled && !!bridge?.prepareArchiveDrag && !!bridge?.startArchiveDrag;
  const ready = useRef(new Map<string, Prepared>());
  const pending = useRef(new Map<string, Promise<PrepareResult>>());
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelGesture = useRef<(() => void) | null>(null);
  const revision = useRef(0);

  useEffect(() => () => {
    clearTimeout(hoverTimer.current);
    cancelGesture.current?.();
    revision.current++;
    ready.current.clear();
    pending.current.clear();
  }, [assetId, supported]);

  function getToken(key: string): string | undefined {
    const file = ready.current.get(key);
    if (file && file.expiresAt > Date.now()) return file.token;
    ready.current.delete(key);
    return undefined;
  }

  function prepare(key: string, entry: ArchiveDragEntry): Promise<PrepareResult> {
    const token = getToken(key);
    if (token) return Promise.resolve({ token });
    const existing = pending.current.get(key);
    if (existing) return existing;
    const currentRevision = revision.current;
    const task = bridge!.prepareArchiveDrag!(entry).catch(() => ({ error: "无法联系桌面文件拖动服务" }))
      .then((result) => {
        if (revision.current !== currentRevision) return result;
        pending.current.delete(key);
        if ("token" in result) {
          if (ready.current.size >= 12) ready.current.delete(ready.current.keys().next().value!);
          ready.current.set(key, { token: result.token, expiresAt: Date.now() + 60_000 });
        }
        return result;
      });
    pending.current.set(key, task);
    return task;
  }

  async function start(token: string, key: string, entry: ArchiveDragEntry, currentRevision: number) {
    if (nativeDragActive) return;
    nativeDragActive = true;
    let result: Awaited<ReturnType<NonNullable<DragBridge["startArchiveDrag"]>>>;
    try {
      result = await bridge!.startArchiveDrag!(token);
    } catch {
      result = { ok: false, error: "无法联系桌面文件拖动服务" };
    } finally { nativeDragActive = false; }
    if (result.ok || revision.current !== currentRevision) return;
    if (result.retry) {
      ready.current.delete(key);
      const fresh = await prepare(key, entry);
      if (revision.current !== currentRevision) return;
      if ("token" in fresh) onToast("info", "文件已重新准备好，请再拖一次");
      else onToast("bad", fresh.error);
    } else onToast("bad", result.error);
  }

  function begin(e: DragEvent<HTMLSpanElement>, key: string, entry: ArchiveDragEntry) {
    e.preventDefault();
    clearTimeout(hoverTimer.current);
    cancelGesture.current?.();
    const currentRevision = revision.current;
    const token = getToken(key);
    if (token) {
      void start(token, key, entry, currentRevision);
      return;
    }

    // Chromium 的默认拖动已取消，鼠标仍按住时可等解压完成后接力给系统。
    let held = true;
    function stop() {
      held = false;
      window.removeEventListener("mouseup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", stop);
      document.removeEventListener("mouseout", leave, true);
      if (cancelGesture.current === stop) cancelGesture.current = null;
    }
    function leave(e: MouseEvent) { if (!e.relatedTarget) stop(); }
    cancelGesture.current = stop;
    window.addEventListener("mouseup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", stop);
    document.addEventListener("mouseout", leave, true);
    onToast("info", "正在准备包内文件，保持按住鼠标");
    void prepare(key, entry).then((result) => {
      const canStart = held;
      stop();
      if (revision.current !== currentRevision) return;
      if ("error" in result) onToast("bad", result.error);
      else if (canStart) void start(result.token, key, entry, currentRevision);
      else onToast("info", "文件已准备好，请再拖一次");
    });
  }

  function propsFor(entryPath: string, nested?: string): HTMLAttributes<HTMLSpanElement> | undefined {
    if (!supported) return undefined;
    const key = JSON.stringify([assetId, nested ?? null, entryPath]);
    const entry = { assetId, entryPath, ...(nested ? { nested } : {}) };
    return {
      className: "nm archive-drag-file",
      draggable: true,
      onPointerEnter: () => {
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => void prepare(key, entry), 120);
      },
      onPointerLeave: () => clearTimeout(hoverTimer.current),
      onPointerDown: (e) => { if (e.button === 0) void prepare(key, entry); },
      onDragStart: (e) => begin(e, key, entry),
    };
  }
  return supported ? propsFor : undefined;
}
