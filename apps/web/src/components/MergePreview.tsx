import { useEffect, useState } from "react";
import { describeError, getItem } from "../api";
import { Spinner } from "./ui";

export interface PreviewImage { id: number; position?: number }
export interface PreviewItem { id: number; title: string; coverImageId: number | null; images: PreviewImage[]; assets: { id: number }[] }

export function validateIds(sourceId: number, targetId: number): string {
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId <= 0 || targetId <= 0) return "合并双方 ID 非法或相同";
  if (sourceId === targetId) return "合并双方 ID 非法或相同";
  return "";
}

export function validateWrapper(raw: any, expectedId: number): { ok: true; item: PreviewItem } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "详情为空" };
  const it = raw.item;
  if (!it || typeof it !== "object") return { ok: false, error: "缺少 item" };
  if (!Number.isInteger(Number(it.id)) || Number(it.id) <= 0) return { ok: false, error: "item.id 非法" };
  if (Number(it.id) !== expectedId) return { ok: false, error: "item.id 与请求不一致" };
  if (typeof it.title !== "string" || !it.title) return { ok: false, error: "缺少标题" };
  if (!Array.isArray(raw.assets)) return { ok: false, error: "缺少顶层 assets" };
  if (!Array.isArray(raw.images)) return { ok: false, error: "缺少顶层 images" };
  return { ok: true, item: { id: Number(it.id), title: it.title, coverImageId: raw.coverImageId ?? null, images: raw.images, assets: raw.assets } };
}

/** 与 repo.mergeItems 一致：target 有 cover 保留；否则取 target 第一张（position,id）。 */
export function pickTargetCover(item: PreviewItem): number | null {
  if (item.coverImageId != null) return item.coverImageId;
  const sorted = [...item.images].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id);
  return sorted.length ? sorted[0]!.id : null;
}

export function buildMergePreview(target: PreviewItem, source: PreviewItem) {
  return {
    targetId: target.id, sourceId: source.id, targetTitle: target.title, sourceTitle: source.title,
    targetImages: target.images, targetCover: pickTargetCover(target),
    sourceAssets: source.assets.length, sourceImagesStay: source.images.length,
  };
}

export function MergePreview(props: { sourceId: number; targetId: number; onClose: () => void; onConfirm: (sourceId: number, targetId: number) => void }) {
  const [state, setState] = useState<{ loading: boolean; error: string; model: ReturnType<typeof buildMergePreview> | null }>({ loading: true, error: "", model: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: "", model: null });
    const idErr = validateIds(props.sourceId, props.targetId);
    if (idErr) { setState({ loading: false, error: idErr, model: null }); return; }
    Promise.all([getItem(props.targetId), getItem(props.sourceId)])
      .then(([t, s]) => {
        if (!alive) return;
        const tv = validateWrapper(t, props.targetId);
        if (!tv.ok) { setState({ loading: false, error: "目标条目：" + tv.error, model: null }); return; }
        const sv = validateWrapper(s, props.sourceId);
        if (!sv.ok) { setState({ loading: false, error: "来源条目：" + sv.error, model: null }); return; }
        setState({ loading: false, error: "", model: buildMergePreview(tv.item, sv.item) });
      })
      .catch((e) => { if (alive) setState({ loading: false, error: describeError(e), model: null }); });
    return () => { alive = false; };
  }, [props.sourceId, props.targetId]);
  const canConfirm = !state.loading && !state.error && !!state.model;
  return (
    <div className="backdrop" onClick={props.onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="合并预览"
        data-testid="merge-preview"
        data-source-id={props.sourceId}
        data-target-id={props.targetId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head"><h3>合并预览</h3><button className="btn" onClick={props.onClose}>取消</button></div>
        <div className="drawer-body" style={{ display: "block", padding: "12px" }}>
          {state.loading && <div className="hint"><Spinner /> 载入两条目详情…</div>}
          {state.error && <div className="err">{state.error}</div>}
          {state.model && (
            <div>
              <div className="hint">主条目（保留）：#{state.model.targetId} {state.model.targetTitle}</div>
              <div className="hint">来源条目（进回收站）：#{state.model.sourceId} {state.model.sourceTitle}</div>
              <div className="notice">最终只保留主条目原有图片 {state.model.targetImages.length} 张；封面 {state.model.targetCover ?? "无"}；来源图片不迁入。</div>
              <div className="notice">来源资产 {state.model.sourceAssets} 个将迁到主条目；来源条目进入回收站（可恢复）。</div>
            </div>
          )}
          <div className="row" style={{ marginTop: "10px" }}>
            <button className="btn" disabled={!canConfirm} onClick={() => { if (canConfirm) props.onConfirm(props.sourceId, props.targetId); }}>确认合并</button>
            <button className="btn" onClick={props.onClose}>取消</button>
          </div>
        </div>
      </div>
    </div>
  );
}
