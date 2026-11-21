/**
 * 批量分类操作条（docs/categories.md §7）：复选框选择模式下的批量主分类 / 子分类 / 移除子分类 /
 * 重新生成建议 / 仅对未分类批量；执行前显示将影响的条数，失败逐条反馈。
 */
import { useMemo, useState } from "react";
import type { CategoryNode } from "@core/contracts";
import { batchSetItemCategory, categoryApiMessage } from "../api";

export function CategoryBatchBar(props: {
  /** 当前选中的条目 id（选择模式） */
  selectedIds: number[];
  /** 选中条目里「未分类」的那些（cat_id IS NULL） */
  uncategorizedIds: number[];
  categories: CategoryNode[];
  /** 后端未提供分类接口时的显式提示（空 = 正常） */
  catErr?: string;
  onClearSelection: () => void;
  onExitSelectMode: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 结果中未成功的条目可留在选择中重试。 */
  onDone: (failedIds: number[]) => void;
}) {
  const [catId, setCatId] = useState("");
  const [subId, setSubId] = useState("");
  const [onlyUncat, setOnlyUncat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ itemId: number; reason: string }[] | null>(null);
  const [note, setNote] = useState("");

  const tops = useMemo(() => props.categories.filter((t) => t.enabled).sort((a, b) => a.sort - b.sort), [props.categories]);
  const subs = useMemo(() => {
    const t = tops.find((x) => x.id === catId);
    return (t?.children ?? []).filter((c) => c.enabled).sort((a, b) => a.sort - b.sort);
  }, [tops, catId]);

  const targets = onlyUncat ? props.uncategorizedIds : props.selectedIds;
  const category = tops.find((c) => c.id === catId);
  const subCategory = subs.find((c) => c.id === subId);

  const run = (action: "set" | "clear_category" | "clear_sub" | "resuggest") => {
    if (busy || !targets.length || (action === "set" && (!category || (subId && !subCategory)))) return;
    const name = action === "set" ? "设置分类"
      : action === "clear_category" ? "清除分类归属"
      : action === "clear_sub" ? "移除子分类" : "重新生成分类建议";
    const targetName = category?.name + (subCategory ? " › " + subCategory.name : "");
    const prompt = action === "set" ? "将 " + targets.length + " 条素材设为「" + targetName + "」？"
      : action === "clear_category" ? "将 " + targets.length + " 条素材设为未分类？"
      : action === "clear_sub" ? "移除 " + targets.length + " 条素材的子分类，保留主分类？"
      : "为 " + targets.length + " 条素材重新生成分类建议？现有分类会保留。";
    if (!window.confirm(prompt)) return;
    setBusy(true); setFailed(null); setNote("");
    batchSetItemCategory({
      itemIds: targets,
      categoryId: action === "clear_category" ? null : action === "set" ? category!.id : undefined,
      subCategoryId: action === "clear_category" ? null : action === "set" ? subCategory?.id ?? null : undefined,
      mode: action === "clear_category" ? "set" : action,
    })
      .then((r) => {
        setFailed(r.failed);
        setNote("请求 " + r.requested + " 条 · 成功 " + r.updated + " 条 · 失败 " + r.failed.length + " 条");
        props.onToast(r.failed.length ? "bad" : "ok",
          name + "：成功 " + r.updated + " / " + r.requested + (r.failed.length ? "，失败 " + r.failed.length + " 条（见下方明细）" : ""));
        props.onDone(r.failed.map((f) => f.itemId));
      })
      .catch((e) => props.onToast("bad", categoryApiMessage(e, "批量分类")))
      .finally(() => setBusy(false));
  };

  return (
    <div className="batch-bar">
      <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
        <b>批量分类</b>
        <span className="hint">已选 {props.selectedIds.length} 条{props.uncategorizedIds.length ? "（其中未分类 " + props.uncategorizedIds.length + " 条）" : ""}</span>
        <span className="spacer" />
        <button className="btn tiny" onClick={props.onClearSelection} disabled={busy || !props.selectedIds.length}>清空选择</button>
        <button className="btn tiny" onClick={props.onExitSelectMode} disabled={busy}>退出批量分类</button>
      </div>

      {props.catErr && <div className="err" style={{ marginTop: "5px" }}>{props.catErr}</div>}

      <div className="row wrap" style={{ gap: "6px", alignItems: "flex-end", marginTop: "6px" }}>
        <label className="cat-field">主分类
          <select value={catId} disabled={busy} onChange={(e) => { setCatId(e.target.value); setSubId(""); }}>
            <option value="">选择主分类</option>
            {tops.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="cat-field">子分类
          <select value={subId} onChange={(e) => setSubId(e.target.value)} disabled={busy || !category}>
            <option value="">（不指定）</option>
            {subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: "4px", alignItems: "center", cursor: "pointer" }} title="只处理选中项里尚未归属任何分类的条目">
          <input type="checkbox" checked={onlyUncat} disabled={busy} onChange={(e) => setOnlyUncat(e.target.checked)} />
          <span className="hint">仅对未分类（{props.uncategorizedIds.length} 条）</span>
        </label>
      </div>

      <div className="row wrap" style={{ gap: "5px", alignItems: "center", marginTop: "6px" }}>
        <span className="hint">将影响 <b style={{ color: "var(--fg)" }}>{targets.length}</b> 条</span>
        <button className="btn tiny primary" disabled={busy || !targets.length || !category || (!!subId && !subCategory)} onClick={() => run("set")}>设置分类</button>
        <details className="batch-secondary">
          <summary>其他分类操作</summary>
          <div className="row wrap">
            <button className="btn tiny" disabled={busy || !targets.length} onClick={() => run("resuggest")}>重新生成建议</button>
            <button className="btn tiny" disabled={busy || !targets.length} onClick={() => run("clear_sub")}>仅移除子分类</button>
            <button className="btn tiny danger" disabled={busy || !targets.length} onClick={() => run("clear_category")}>清除分类归属</button>
          </div>
        </details>
        {busy && <span className="spin" />}
      </div>

      {note && <div className="hint" style={{ marginTop: "5px" }}>{note}</div>}
      {failed && failed.length > 0 && (
        <div className="cat-failed">
          <div className="hint">失败明细（逐条）：</div>
          {failed.slice(0, 50).map((f) => (
            <div className="cat-fail-row" key={f.itemId}>
              <span className="mono">#{f.itemId}</span>
              <span className="why">{f.reason}</span>
            </div>
          ))}
          {failed.length > 50 && <div className="hint">…还有 {failed.length - 50} 条</div>}
        </div>
      )}
    </div>
  );
}
