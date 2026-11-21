/**
 * BOOTH 更正（task-71；frozen-interface-B1.md §两个新端点/§界面）。
 *
 * 语义边界：
 * - 只在用户点开并点「预览」后才请求；预览只读（服务端零业务写）。
 * - 确认必须显式勾选；body 固定为 {url, expectedSourceSite/Id/Url, expectedTargetItemId, confirm:true}，
 *   旧 binding 取自预览的 current，不自行调用旧 linkBooth/patchItem/merge。
 * - 取消/URL 改变/409 STALE 都清掉旧预览与勾选；不虚构 TTL。
 * - 成功只重载真实详情 + 通知父刷新，不拼伪更新卡片。
 */
import { useRef, useState } from "react";
import { ApiError, boothCorrectionConfirm, boothCorrectionPreview, describeError } from "../api";
import type { BoothCorrectionConfirmBody, BoothCorrectionPreview } from "../api";
import { Spinner } from "./ui";

export interface BoothCorrectionConflict {
  code: string;
  conflictItemId?: number;
  title?: string;
}

/** 只认 409 + 三个 BOOTH_CORRECTION_* 子码；其它错误返回 null（走普通错误通道）。 */
export function boothCorrectionConflictOf(e: unknown): BoothCorrectionConflict | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.details as { code?: unknown; conflictItemId?: unknown; title?: unknown } | undefined;
  if (!d || typeof d !== "object") return null;
  const code = d.code;
  if (code !== "BOOTH_CORRECTION_STALE" && code !== "BOOTH_CORRECTION_OCCUPIED" && code !== "BOOTH_CORRECTION_TARGET_MISMATCH") return null;
  const out: BoothCorrectionConflict = { code };
  const id = Number(d.conflictItemId);
  if (Number.isInteger(id) && id > 0) out.conflictItemId = id;
  if (typeof d.title === "string" && d.title !== "") out.title = d.title;
  return out;
}

export interface BoothCorrectionHandlerDeps {
  api: {
    preview: (itemId: number, url: string) => Promise<BoothCorrectionPreview>;
    confirm: (itemId: number, body: BoothCorrectionConfirmBody) => Promise<{ changed: boolean }>;
  };
  itemId: number;
  getUrl: () => string;
  getPreview: () => BoothCorrectionPreview | null;
  getConfirmed: () => boolean;
  /** 同步忙碌镜像（ref 语义）：必须能读到「同 tick 已置忙」的值，不能只读 React state 闭包。 */
  getBusy: () => string;
  setPreview: (p: BoothCorrectionPreview | null) => void;
  setConfirmed: (v: boolean) => void;
  setError: (e: string) => void;
  setBusy: (b: string) => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  describeError: (e: unknown) => string;
  reload: () => void;
  onChanged: () => void;
}

export interface BoothCorrectionHandlers {
  preview: () => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => void;
}

export function createBoothCorrectionHandlers(deps: BoothCorrectionHandlerDeps): BoothCorrectionHandlers {
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    // 同步门（B2 F1）：已 busy 或同 tick 首个 Promise 未完成时直接返回。
    // 读的是同步镜像而非 React state 闭包，因此跨重渲染仍有效。
    if (deps.getBusy()) return;
    deps.setBusy(label);
    deps.setError("");
    try {
      await fn();
    } catch (e) {
      const c = boothCorrectionConflictOf(e);
      if (c?.code === "BOOTH_CORRECTION_STALE" || c?.code === "BOOTH_CORRECTION_TARGET_MISMATCH") {
        deps.setPreview(null);
        deps.setConfirmed(false);
        deps.onToast("bad", c.code === "BOOTH_CORRECTION_STALE"
          ? "条目绑定已变化，请重新预览"
          : "目标商品与预览不一致，请重新预览");
        return;
      }
      if (c?.code === "BOOTH_CORRECTION_OCCUPIED") {
        deps.onToast("bad", "目标商品已被 #" + (c.conflictItemId ?? "?") + (c.title ? "「" + c.title + "」" : "") + " 占用");
        return;
      }
      const message = deps.describeError(e);
      deps.setError(message);
      deps.onToast("bad", label + "失败：" + message);
    } finally {
      deps.setBusy("");
    }
  };

  const preview = () => run("预览", async () => {
    const url = deps.getUrl().trim();
    if (!url) { deps.onToast("bad", "先填 BOOTH 商品链接"); return; }
    const p = await deps.api.preview(deps.itemId, url);
    deps.setPreview(p);
    deps.setConfirmed(false);
    deps.onToast("info", p.conflict
      ? "预览完成（未写入）：目标商品已被 #" + p.conflict.itemId + "「" + p.conflict.title + "」占用"
      : "预览完成（未写入）：将更正为 " + p.target.itemId);
  });

  const confirm = () => run("确认更正", async () => {
    const p = deps.getPreview();
    if (!p) { deps.onToast("bad", "先预览再确认"); return; }
    if (!deps.getConfirmed()) { deps.onToast("bad", "请先勾选确认更正"); return; }
    if (p.conflict) {
      deps.onToast("bad", "目标商品已被 #" + p.conflict.itemId + "「" + p.conflict.title + "」占用，不能更正");
      return;
    }
    const body: BoothCorrectionConfirmBody = {
      url: deps.getUrl().trim(),
      expectedSourceSite: p.current.sourceSite,
      expectedSourceItemId: p.current.sourceItemId,
      expectedSourceUrl: p.current.sourceUrl,
      expectedTargetItemId: p.target.itemId,
      confirm: true,
    };
    const r = await deps.api.confirm(deps.itemId, body);
    deps.onToast("ok", r.changed ? "已更正 BOOTH 绑定" : "绑定已一致，未改动");
    deps.setPreview(null);
    deps.setConfirmed(false);
    deps.reload();
    deps.onChanged();
  });

  const cancel = () => {
    deps.setPreview(null);
    deps.setConfirmed(false);
    deps.setError("");
  };

  return { preview, confirm, cancel };
}

export function BoothCorrectionSection(props: {
  itemId: number;
  reload: () => void;
  onChanged: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<BoothCorrectionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // 同步忙碌镜像：setBusy 立即写 ref，handler 的 getBusy 立刻可读（跨重渲染仍挡住重复提交）。
  const busyRef = useRef("");
  const setBusySync = (b: string) => { busyRef.current = b; setBusy(b); };

  const handlers = createBoothCorrectionHandlers({
    api: { preview: boothCorrectionPreview, confirm: boothCorrectionConfirm },
    itemId: props.itemId,
    getUrl: () => url,
    getPreview: () => preview,
    getConfirmed: () => confirmed,
    getBusy: () => busyRef.current,
    setPreview, setConfirmed, setError, setBusy: setBusySync,
    onToast: props.onToast,
    describeError,
    reload: props.reload,
    onChanged: props.onChanged,
  });

  return (
    <span style={{ marginLeft: "6px" }}>
      <button
        className="btn tiny"
        onClick={() => { setOpen((v) => !v); setError(""); }}
        title="预览旧/新商品后显式确认更正；不改标题/图片/资产"
      >{open ? "收起更正" : "更正 BOOTH…"}</button>
      {open && (
        <div style={{ marginTop: "6px", borderTop: "1px solid var(--line-soft)", paddingTop: "6px" }}>
          <div className="row wrap" style={{ gap: "6px" }}>
            <input
              type="url"
              style={{ flex: 1 }}
              value={url}
              placeholder="https://booth.pm/ja/items/222"
              onChange={(e) => { setUrl(e.target.value); setPreview(null); setConfirmed(false); }}
            />
            <button className="btn tiny" disabled={!!busy} onClick={() => void handlers.preview()}>预览</button>
            <button className="btn tiny ghost" disabled={!!busy} onClick={handlers.cancel}>取消</button>
          </div>
          {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}
          {preview && (
            <div className="hint" style={{ marginTop: "4px" }}>
              当前：{preview.current.sourceSite ?? "—"} {preview.current.sourceItemId ?? "—"} · {preview.current.sourceUrl ?? "—"}
              <br />目标：{preview.target.itemId} · {preview.target.title} · {preview.target.shop?.name ?? "—"} · {preview.target.priceText ?? "—"} · {preview.target.imageCount} 图 / {preview.target.fileCount} 文件
              <br />将改：{preview.willChange.join("、") || "—"}；保留：{preview.willPreserve.join("、") || "—"}
              <br />标题/描述/备注/图片/资产等人工资料不会被覆盖。
              {preview.conflict && (
                <div style={{ color: "var(--warn)" }}>目标商品已被 #{preview.conflict.itemId}「{preview.conflict.title}」占用，不能更正。</div>
              )}
            </div>
          )}
          {preview && !preview.conflict && (
            <label className="chk" style={{ marginTop: "4px" }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              我确认把来源更正为 #{preview.target.itemId}（不改标题/图片/资产）
            </label>
          )}
          <div className="row" style={{ gap: "6px", marginTop: "4px" }}>
            <button
              className="btn tiny"
              disabled={!!busy || !preview || !confirmed || !!preview?.conflict}
              onClick={() => void handlers.confirm()}
            >{busy === "确认更正" ? <Spinner /> : "确认更正"}</button>
          </div>
        </div>
      )}
    </span>
  );
}
