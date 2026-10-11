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
  /** 任一批量操作成功后：刷新列表 + 清空选择 */
  onDone: () => void;
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

  const run = (mode: "set" | "clear_sub" | "resuggest") => {
    if (!targets.length) { props.onToast("info", "没有可处理的条目" + (onlyUncat ? "（选中项里没有未分类的）" : "")); return; }
    if (mode === "set" && !catId && !window.confirm("把选中的 " + targets.length + " 条**清除分类归属**（→ 未分类）？")) return;
    if (mode === "set" && catId) {
      const label = tops.find((t) => t.id === catId)?.name ?? catId;
      const subLabel = subs.find((c) => c.id === subId)?.name;
      if (!window.confirm("将把 " + targets.length + " 条设为「" + label + (subLabel ? " › " + subLabel : "") + "」？\n（来源记为 manual；手动/已采纳的分类永不被自动任务覆盖）")) return;
    }
    if (mode === "clear_sub" && !window.confirm("将把 " + targets.length + " 条的**子分类**移除（保留主分类）？")) return;
    if (mode === "resuggest" && !window.confirm("将为 " + targets.length + " 条重新生成分类建议？\n（高置信度自动应用；已有手动/已采纳归属的只写建议，不覆盖）")) return;
    setBusy(true); setFailed(null); setNote("");
    batchSetItemCategory({
      itemIds: targets,
      categoryId: mode === "set" ? (catId || null) : undefined,
      subCategoryId: mode === "set" ? (subId || null) : undefined,
      mode,
    })
      .then((r) => {
        setFailed(r.failed);
        setNote("请求 " + r.requested + " 条 · 成功 " + r.updated + " 条 · 失败 " + r.failed.length + " 条");
        props.onToast(r.failed.length ? "bad" : "ok",
          (mode === "set" ? "批量设置分类" : mode === "clear_sub" ? "批量移除子分类" : "批量重新生成建议")
          + "：成功 " + r.updated + " / " + r.requested + (r.failed.length ? "，失败 " + r.failed.length + " 条（见下方明细）" : ""));
        props.onDone();
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
        <button className="btn tiny" onClick={props.onClearSelection} disabled={!props.selectedIds.length}>清空选择</button>
        <button className="btn tiny" onClick={props.onExitSelectMode}>退出选择模式</button>
      </div>

      {props.catErr && <div className="err" style={{ marginTop: "5px" }}>{props.catErr}</div>}

      <div className="row wrap" style={{ gap: "6px", alignItems: "flex-end", marginTop: "6px" }}>
        <label className="cat-field">主分类
          <select value={catId} onChange={(e) => { setCatId(e.target.value); setSubId(""); }}>
            <option value="">（清除归属）</option>
            {tops.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="cat-field">子分类
          <select value={subId} onChange={(e) => setSubId(e.target.value)} disabled={!catId}>
            <option value="">（不指定）</option>
            {subs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: "4px", alignItems: "center", cursor: "pointer" }} title="只处理选中项里尚未归属任何分类的条目">
          <input type="checkbox" checked={onlyUncat} onChange={(e) => setOnlyUncat(e.target.checked)} />
          <span className="hint">仅对未分类（{props.uncategorizedIds.length} 条）</span>
        </label>
      </div>

      <div className="row wrap" style={{ gap: "5px", alignItems: "center", marginTop: "6px" }}>
        <span className="hint">将影响 <b style={{ color: "var(--fg)" }}>{targets.length}</b> 条</span>
        <button className="btn tiny" disabled={busy || !targets.length} onClick={() => run("set")}>批量设置主/子分类</button>
        <button className="btn tiny" disabled={busy || !targets.length} onClick={() => run("clear_sub")} title="只移除子分类，保留主分类">批量移除子分类</button>
        <button className="btn tiny" disabled={busy || !targets.length} onClick={() => run("resuggest")} title="POST /api/items/category/batch { mode: resuggest }">批量重新生成建议</button>
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
