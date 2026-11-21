/**
 * App 级全局拖入/粘贴入口（task-87；G1 C4：单例、任意页有效）。
 *
 * 只做「监听 + 覆盖层 + 把路径交给 App」；解析在 file-intake，注入与预检在 ImportPanel。
 * 监听卸载由本组件的 effect cleanup 负责（纯模块不注册监听，因此没有假 dispose）。
 */
import { useEffect, useRef, useState } from "react";
import { isArchiveDragActive } from "./archive-file-drag";
import { createFileIntake, isEditableTarget } from "./file-intake";

export function GlobalDrop(props: {
  onPaths: (paths: string[]) => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const [hot, setHot] = useState(false);
  const intakeRef = useRef(createFileIntake({
    getPathForFile: (f) => (typeof window === "undefined" ? null : window.assetVaultDesktop?.getPathForFile(f) ?? null),
  }));

  useEffect(() => {
    const intake = intakeRef.current;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    // W3：可编辑区上方不显示覆盖层（那里 drop 走原生插入，提示会与实际行为不一致）。
    const onDragEnter = (e: DragEvent) => { if (!isArchiveDragActive() && hasFiles(e) && !isEditableTarget(e.target)) setHot(true); };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (isArchiveDragActive()) return;
      setHot(!isEditableTarget(e.target));
    };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setHot(false); };
    const onDrop = (e: DragEvent) => {
      setHot(false);
      if (isArchiveDragActive() && hasFiles(e)) { e.preventDefault(); return; }
      const r = intake.handleDrop(e);
      if (r.paths.length) props.onPaths(r.paths);
      else if (r.reason === "no-path" && r.ignored > 0) props.onToast("info", "浏览器不暴露本地绝对路径，已忽略 " + r.ignored + " 个文件（请改用粘贴路径）");
      // 忙碌门在 ImportPanel（预检中/提交中/待确认）；这里只负责收集路径。
    };
    const onPaste = (e: ClipboardEvent) => {
      const r = intake.handlePaste(e);
      if (r.paths.length) props.onPaths(r.paths);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [props.onPaths, props.onToast]);

  if (!hot) return null;
  return (
    <div
      className="global-drop-overlay"
      style={{
        // W1：低于 toast(60)，拖拽中的失败提示仍可见。
        position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center",
        background: "rgba(10,14,20,.72)", color: "var(--fg)", fontSize: "18px", pointerEvents: "none",
      }}
    >
      松开导入
    </div>
  );
}
