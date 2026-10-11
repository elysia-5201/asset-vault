/**
 * 详情页「分类」编辑区（docs/categories.md §7）：
 * 主分类下拉 → 子分类联动下拉（切主分类即清空不再属于它的子分类）→ 保存 → 立即刷新；
 * 显示来源标签（手动设置/采纳建议/自动推断/历史迁移）；自动来源显示依据 + 置信度（证据可折叠）；
 * 建议卡片带「采纳」「忽略」。分类接口 404/不支持时**显式提示**，不静默。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryEvidenceHit, CategoryNode, CategoryRefSource } from "@core/contracts";
import {
  acceptCategorySuggestion, categoryApiMessage, dismissCategorySuggestion, getCategories,
  isCategoryApiMissing, reclassifyCategories, setItemCategory,
} from "../api";
import { FIELD_LABEL } from "@core/categories/classify";
import type { CategoryConfig, ItemDetailWeb } from "../types";
import { Badge, CATEGORY_SOURCE_LABEL, Collapsible, Section, Spinner } from "./ui";

/** 证据条目兼容两种形状：库里的紧凑 JSON（field/matched/gain/cat/sub）与推荐结果（带 fieldLabel/keyword）。 */
function evidenceRows(evidence: unknown[] | null): { label: string; text: string; gain: number | null }[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((raw) => {
    const e = (raw ?? {}) as Partial<CategoryEvidenceHit> & { field?: string; matched?: string; gain?: number; keyword?: string; cat?: string; sub?: string | null };
    const field = String(e.field ?? "?");
    const label = e.fieldLabel ?? (FIELD_LABEL as Record<string, string>)[field] ?? field;
    const matched = String(e.matched ?? "");
    const kw = e.keyword && e.keyword !== matched ? "（关键词 " + e.keyword + "）" : "";
    const cat = e.cat ?? e.categoryId ?? null;
    return {
      label,
      text: (matched ? matched + kw : "—") + (cat ? "  → " + cat : ""),
      gain: typeof e.gain === "number" ? e.gain : null,
    };
  });
}

export function CategoryEditor(props: {
  detail: ItemDetailWeb;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 保存 / 采纳 / 忽略 / 重新推断成功：重拉详情 + 通知列表刷新 */
  onSaved: () => void;
  onBusy?: (b: boolean) => void;
}) {
  const itemId = props.detail.id;
  const [tree, setTree] = useState<CategoryNode[] | null>(null);
  const [catErr, setCatErr] = useState("");
  /** 后端根本没提供分类接口（404/405/501）——文案要明确区分「不可用」和「未分类」 */
  const [catMissing, setCatMissing] = useState(false);
  const [config, setConfig] = useState<CategoryConfig | null>(null);
  const [pickCat, setPickCat] = useState("");
  const [pickSub, setPickSub] = useState("");
  const [busy, setBusy] = useState(false);

  const loadTree = useCallback(() => {
    setCatErr(""); setCatMissing(false);
    getCategories()
      .then((r) => { setTree(r.categories); setConfig(r.config); })
      .catch((e) => { setTree([]); setCatMissing(isCategoryApiMissing(e)); setCatErr(categoryApiMessage(e, "加载分类树")); });
  }, []);
  useEffect(() => { loadTree(); }, [loadTree]);

  const it = props.detail.item;
  const cat = props.detail.category ?? null;
  const curCat = cat?.categoryId ?? it.cat_id ?? "";
  const curSub = cat?.subCategoryId ?? it.cat_sub_id ?? "";

  // 每次详情刷新（或换条目）把下拉重置为服务端当前归属
  useEffect(() => {
    setPickCat(curCat);
    setPickSub(curSub);
  }, [itemId, curCat, curSub]);

  const tops = useMemo(() => {
    const list = tree ?? [];
    // 停用的分类不进下拉，但**当前已归属**的那个仍要显示（否则用户看到的是"没分类"）
    return list.filter((t) => t.enabled || t.id === curCat).sort((a, b) => a.sort - b.sort);
  }, [tree, curCat]);

  const subs = useMemo(() => {
    const t = tops.find((x) => x.id === pickCat);
    if (!t) return [];
    return (t.children ?? []).filter((c) => c.enabled || c.id === curSub).sort((a, b) => a.sort - b.sort);
  }, [tops, pickCat, curSub]);

  const dirty = pickCat !== curCat || pickSub !== curSub;
  const catLabel = (id: string): string => {
    if (!id) return "";
    for (const t of tree ?? []) {
      if (t.id === id) return t.name;
      const c = (t.children ?? []).find((x) => x.id === id);
      if (c) return t.name + " › " + c.name;
    }
    // 分类树里找不到（被删/改名）：退回条目上带的 name，绝不显示成"未分类"
    if (id === cat?.categoryId) return cat?.categoryName ?? id;
    if (id === cat?.subCategoryId) return cat?.subCategoryName ?? id;
    return id;
  };
  /** 只取节点自己的名字（不带「主 › 」前缀），用于 toast 文案 */
  const nameOf = (id: string): string => {
    for (const t of tree ?? []) {
      if (t.id === id) return t.name;
      const c = (t.children ?? []).find((x) => x.id === id);
      if (c) return c.name;
    }
    return catLabel(id).split(" › ").pop() ?? id;
  };

  const run = (p: Promise<unknown>, okText: string, failAction: string) => {
    setBusy(true); props.onBusy?.(true);
    p.then(() => { props.onToast("ok", okText); props.onSaved(); })
      .catch((e) => props.onToast("bad", categoryApiMessage(e, failAction)))
      .finally(() => { setBusy(false); props.onBusy?.(false); });
  };

  const save = () => run(
    setItemCategory(itemId, { categoryId: pickCat || null, subCategoryId: pickSub || null }),
    pickCat ? "已保存分类：" + nameOf(pickCat) + (pickSub ? " › " + nameOf(pickSub) : "") : "已清除分类归属（→ 未分类）",
    "保存分类",
  );
  const accept = () => run(acceptCategorySuggestion(itemId), "已采纳建议（来源 = 采纳建议）", "采纳建议");
  const dismiss = () => run(dismissCategorySuggestion(itemId), "已忽略这条建议", "忽略建议");
  const resuggest = () => run(
    reclassifyCategories({ itemIds: [itemId], apply: true }),
    "已按当前标题/标签重新推断（高置信度自动应用；手动/已采纳的只写建议）",
    "重新推断分类",
  );

  const src = cat?.source ?? null;
  const evRows = evidenceRows(cat?.evidence ?? null);
  const sug = props.detail.suggestion ?? null;
  const sugEv = evidenceRows(sug?.evidence ?? null);
  const pct = (c: number | null | undefined): string => (typeof c === "number" ? Math.round(c * 100) + "%" : "—");

  return (
    <Section
      title="分类"
      right={<button className="btn tiny" disabled={!dirty || busy} onClick={save} title="POST /items/:id/category（source=manual）">保存</button>}
    >
      {catErr && (
        <div className="notice bad" style={{ marginBottom: "6px" }}>
          {catErr}
          <div className="row" style={{ marginTop: "4px" }}>
            <span className="hint">
              {catMissing
                ? "后端未提供分类接口：这里显示的是「不可用」，不代表该条目未分类。接口上线后点「重新检测」即可。"
                : "分类接口暂时失败（网络/超时），已归属的分类信息仍按条目上的字段显示。"}
            </span>
            <span className="spacer" />
            <button className="btn tiny" onClick={loadTree}>{catMissing ? "重新检测" : "重试"}</button>
          </div>
        </div>
      )}

      {tree === null ? (
        <div className="hint"><Spinner /> 载入分类树…</div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: "6px", alignItems: "flex-end" }}>
            <label className="cat-field">主分类
              <select
                value={pickCat}
                disabled={!!catErr}
                onChange={(e) => {
                  setPickCat(e.target.value);
                  setPickSub(""); // 切主分类必须清空不再属于它的子分类
                }}
              >
                <option value="">（未分类）</option>
                {tops.map((t) => <option key={t.id} value={t.id}>{t.name}{t.enabled ? "" : "（已停用）"}</option>)}
              </select>
            </label>
            <label className="cat-field">子分类
              <select value={pickSub} disabled={!pickCat || !!catErr} onChange={(e) => setPickSub(e.target.value)}>
                <option value="">（不指定子分类）</option>
                {subs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? "" : "（已停用）"}</option>)}
              </select>
            </label>
            <button className="btn tiny" disabled={!dirty || busy || !!catErr} onClick={save}>{busy ? "保存中…" : "保存"}</button>
            <button className="btn tiny" disabled={busy || !!catErr} title="重跑 /api/categories/reclassify（仅本条）" onClick={resuggest}>重新推断</button>
          </div>

          <div className="row wrap" style={{ gap: "6px", marginTop: "6px", alignItems: "center" }}>
            {src
              ? <Badge tone={src === "manual" ? "muted" : src === "confirmed" ? "ok" : src === "auto" ? "busy" : "violet"}>{CATEGORY_SOURCE_LABEL[src as CategoryRefSource]}</Badge>
              : <Badge tone="muted">未分类</Badge>}
            <span className="hint">当前：{cat && cat.categoryId ? (cat.subCategoryName ? cat.categoryName + " › " + cat.subCategoryName : cat.categoryName) : "未分类（cat_id IS NULL）"}</span>
            {typeof cat?.confidence === "number" && <span className="hint">置信度 {pct(cat.confidence)}（未校准，仅用于阈值比较）</span>}
            {cat?.assignedAt && <span className="hint">· {cat.assignedAt.slice(0, 19).replace("T", " ")}</span>}
          </div>

          {(src === "auto" || cat?.reason) && (
            <div style={{ marginTop: "5px" }}>
              {cat?.reason && <div className="hint">{cat.reason}</div>}
              {evRows.length > 0 && (
                <Collapsible label={"命中证据 " + evRows.length + " 条（" + (src === "auto" ? "自动推断依据" : "分类依据") + "）"} count={evRows.length}>
                  <div className="cat-evidence">
                    {evRows.map((e, i) => (
                      <div className="cat-ev" key={i}>
                        <span className="k">{e.label}</span>
                        <span className="v" title={e.text}>{e.text}</span>
                        {e.gain !== null && <span className="g">+{e.gain}</span>}
                      </div>
                    ))}
                  </div>
                </Collapsible>
              )}
              {!cat?.evidence && <div className="hint">（没有存下来的证据字段）</div>}
            </div>
          )}

          {config && (
            <div className="hint" style={{ marginTop: "5px" }}>
              自动应用阈值 {(config.autoThreshold * 100).toFixed(0)}% · 建议阈值 {(config.suggestThreshold * 100).toFixed(0)}%（GET /api/categories 的 config）
            </div>
          )}

          {sug && (
            <div className="notice cat-suggest" style={{ marginTop: "7px" }}>
              <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
                <Badge tone="warn">待确认建议</Badge>
                <b>{sug.subCategoryName ? sug.categoryName + " › " + sug.subCategoryName : sug.categoryName}</b>
                <span className="hint">置信度 {pct(sug.confidence)}</span>
                <span className="spacer" />
                <button className="btn tiny" disabled={busy} onClick={accept} title="POST /items/:id/category/accept（source=confirmed）">采纳</button>
                <button className="btn tiny" disabled={busy} onClick={dismiss} title="POST /items/:id/category/dismiss（只清建议，不动归属）">忽略</button>
              </div>
              {sug.reason && <div className="hint" style={{ marginTop: "3px" }}>{sug.reason}</div>}
              {sugEv.length > 0 && (
                <Collapsible label="建议依据" count={sugEv.length} defaultOpen>
                  <div className="cat-evidence">
                    {sugEv.map((e, i) => (
                      <div className="cat-ev" key={i}>
                        <span className="k">{e.label}</span>
                        <span className="v" title={e.text}>{e.text}</span>
                        {e.gain !== null && <span className="g">+{e.gain}</span>}
                      </div>
                    ))}
                  </div>
                </Collapsible>
              )}
            </div>
          )}
          {!sug && <div className="hint" style={{ marginTop: "5px" }}>没有待确认建议（自动推断只在高置信度时自动应用，其余保持未分类）。</div>}
        </>
      )}
    </Section>
  );
}
