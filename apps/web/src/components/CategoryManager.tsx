/**
 * 分类管理（v3 §6/§8）：顶栏入口打开的浮层。
 *
 * 左侧一级列表（素材数 / 系统标记 / 启用状态），点选后右侧显示其子分类与编辑区：
 * 新增一级 / 新增子分类 / 重命名 / 上移下移 / 子分类移动到另一个一级 / 启用停用 / 删除 / 合并。
 * 删除与合并前先 GET /api/categories/:id/impact 显示影响面并要求二次确认；转移目标可选（某分类 / 未分类）。
 * 系统分类（builtin=true）不可删除、不可停用（按钮禁用并说明）；标签管理在同一浮层的第二个页签。
 */
import { useMemo, useState } from "react";
import type { CategoryNode, TagRow } from "@core/contracts";
import { UNCATEGORIZED_ID } from "@core/categories/taxonomy";
import {
  categoryApiMessage, createCategory, createTag, deleteCategory, deleteTag,
  getCategoryImpact, mergeCategory, moveCategory, updateCategory, updateTag,
} from "../api";
import type { CategoryImpact, CategoryStats, TagListRow } from "../types";
import { Badge, Spinner } from "./ui";

const bySort = (a: { sort: number; id: string }, b: { sort: number; id: string }): number => a.sort - b.sort || a.id.localeCompare(b.id);

export function CategoryManager(props: {
  categories: CategoryNode[];
  catStats?: CategoryStats | null;
  catErr?: string;
  tags: TagRow[];
  onClose: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 分类/标签写成功后：刷新分类树、计数与列表 */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"cats" | "tags">("cats");
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTop, setNewTop] = useState("");
  const [newSub, setNewSub] = useState("");
  const [rename, setRename] = useState("");
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [transferTo, setTransferTo] = useState("none");
  const [impact, setImpact] = useState<{ id: string; name: string; kind: "delete" | "merge"; data: CategoryImpact } | null>(null);
  // 标签：新建表单 + 每行的编辑草稿 + 删除二次确认
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#4da3ff");
  const [tagEdits, setTagEdits] = useState<Record<number, { name: string; color: string }>>({});
  const [tagDeleteId, setTagDeleteId] = useState<number | null>(null);

  const tops = useMemo(() => [...props.categories].sort(bySort), [props.categories]);
  const findNode = (id: string | null): CategoryNode | null => {
    if (!id) return null;
    for (const t of tops) {
      if (t.id === id) return t;
      const c = (t.children ?? []).find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  };
  const sel = findNode(selId);
  const selParent = sel?.parentId ? findNode(sel.parentId) : null;
  const siblings = (parentId: string | null | undefined): CategoryNode[] =>
    parentId ? [...(findNode(parentId)?.children ?? [])].sort(bySort) : tops;
  const sameLevel = (node: CategoryNode): CategoryNode[] =>
    siblings(node.parentId).filter((n) => n.id !== node.id);

  const run = (p: Promise<unknown>, okText: string, failAction: string, after?: () => void) => {
    setBusy(true);
    p.then(() => { props.onToast("ok", okText); props.onChanged(); after?.(); })
      .catch((e) => props.onToast("bad", categoryApiMessage(e, failAction)))
      .finally(() => setBusy(false));
  };

  /** 上移/下移：只和相邻节点交换 sort；两者 sort 相同时重排整个同级列表。 */
  const shift = (node: CategoryNode, dir: -1 | 1) => {
    const list = siblings(node.parentId);
    const i = list.findIndex((n) => n.id === node.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i]; const b = list[j];
    setBusy(true);
    const jobs: Promise<unknown>[] = a.sort === b.sort
      ? list.map((n, idx) => updateCategory(n.id, { sort: (idx + 1) * 10 }))
      : [updateCategory(a.id, { sort: b.sort }), updateCategory(b.id, { sort: a.sort })];
    Promise.all(jobs)
      .then(() => { props.onToast("ok", "已" + (dir < 0 ? "上移" : "下移") + "「" + node.name + "」"); props.onChanged(); })
      .catch((e) => props.onToast("bad", categoryApiMessage(e, "调整顺序")))
      .finally(() => setBusy(false));
  };

  const openImpact = (node: CategoryNode, kind: "delete" | "merge") => {
    setBusy(true);
    getCategoryImpact(node.id)
      .then((data) => { setImpact({ id: node.id, name: node.name, kind, data }); setTransferTo("none"); setMergeInto(""); })
      .catch((e) => props.onToast("bad", categoryApiMessage(e, kind === "delete" ? "读取删除影响面" : "读取合并影响面")))
      .finally(() => setBusy(false));
  };

  const doDelete = () => {
    if (!impact) return;
    const target = transferTo === "none" ? null : transferTo;
    run(
      deleteCategory(impact.id, transferTo === "none" ? "none" : target),
      "已删除分类「" + impact.name + "」，素材已转移",
      "删除分类",
      () => { setImpact(null); setSelId(null); },
    );
  };
  const doMerge = () => {
    if (!impact || !mergeInto) return;
    run(mergeCategory(impact.id, mergeInto), "已合并「" + impact.name + "」到目标分类", "合并分类", () => { setImpact(null); setSelId(null); });
  };

  const selectedTags: TagListRow[] = props.tags as TagListRow[];

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer cat-manager" role="dialog" aria-label="分类管理" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>分类管理</h3>
          <div className="seg">
            <button className={tab === "cats" ? "on" : ""} onClick={() => setTab("cats")}>分类</button>
            <button className={tab === "tags" ? "on" : ""} onClick={() => setTab("tags")}>标签</button>
          </div>
          {busy && <Spinner />}
          <span className="spacer" />
          <button className="btn tiny" onClick={() => { props.onChanged(); }}>刷新</button>
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>

        {tab === "cats" ? (
          <div className="drawer-body">
            <div className="left">
              {props.catErr ? <div className="err">{props.catErr}</div> : null}
              <div className="row" style={{ gap: "5px" }}>
                <input
                  type="text" placeholder="新增一级分类名称" value={newTop}
                  onChange={(e) => setNewTop(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newTop.trim()) { run(createCategory({ name: newTop.trim() }), "已新增一级分类：" + newTop.trim(), "新增一级分类", () => setNewTop("")); } }}
                />
                <button
                  className="btn tiny" disabled={busy || !newTop.trim()}
                  onClick={() => run(createCategory({ name: newTop.trim() }), "已新增一级分类：" + newTop.trim(), "新增一级分类", () => setNewTop(""))}
                >新增一级</button>
              </div>

              <div className="cat-manager-list">
                {tops.map((t) => (
                  <button
                    key={t.id}
                    className={"cat-mgr-row" + (selId === t.id ? " on" : "")}
                    onClick={() => { setSelId(t.id); setRenameFor(null); setImpact(null); }}
                    title={t.id + (t.builtin ? " · 系统分类" : " · 自建分类")}
                  >
                    <span className="nm">{t.name}</span>
                    <span className="n">{t.itemCount}</span>
                    {t.builtin && <span className="mark" title="系统内置分类：不可删除、不可停用">系统</span>}
                    {!t.enabled && <span className="mark off" title="已停用（不出现在选择列表，但已归属的素材仍按原分类显示）">停用</span>}
                  </button>
                ))}
              </div>
              <div className="hint">
                共 {tops.length} 个一级分类 / {tops.reduce((n, t) => n + (t.children?.length ?? 0), 0)} 个子分类 · 数字是「全局」计数（GET /api/categories 的 stats）
                {props.catStats ? "（在库 " + props.catStats.total + " 条 · 未分类 " + props.catStats.uncategorized + " 条 · 待确认建议 " + props.catStats.pending + " 条）" : ""}
              </div>
            </div>

            <div className="right">
              {!sel && <div className="hint">← 从左侧选择一个分类，查看/编辑它的子分类与属性。</div>}

              {sel && (
                <>
                  <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
                    <b>{selParent ? selParent.name + " › " + sel.name : sel.name}</b>
                    {sel.builtin ? <Badge tone="violet" title="is_system=true：不可删除、不可停用，但可改名/排序/移动">系统分类</Badge> : <Badge tone="muted">自建分类</Badge>}
                    <Badge tone={sel.enabled ? "ok" : "warn"}>{sel.enabled ? "启用中" : "已停用"}</Badge>
                    <span className="hint">素材 {sel.itemCount} 条 · id=<span className="mono">{sel.id}</span></span>
                  </div>

                  <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
                    <input
                      type="text" style={{ maxWidth: "220px" }}
                      placeholder="改名后的名称"
                      value={renameFor === sel.id ? rename : sel.name}
                      onFocus={() => { setRenameFor(sel.id); setRename(sel.name); }}
                      onChange={(e) => { setRenameFor(sel.id); setRename(e.target.value); }}
                    />
                    <button
                      className="btn tiny"
                      disabled={busy || renameFor !== sel.id || !rename.trim() || rename.trim() === sel.name}
                      onClick={() => run(updateCategory(sel.id, { name: rename.trim() }), "已重命名为「" + rename.trim() + "」", "重命名")}
                    >重命名</button>
                    <button className="btn tiny" disabled={busy} title="只改 sort，不动其它分类" onClick={() => shift(sel, -1)}>↑ 上移</button>
                    <button className="btn tiny" disabled={busy} title="只改 sort，不动其它分类" onClick={() => shift(sel, 1)}>↓ 下移</button>
                    <button
                      className="btn tiny" disabled={busy || sel.builtin}
                      title={sel.builtin ? "系统分类不可停用（它必须永远可访问）" : "停用后不出现在筛选/下拉里；已归属的素材保持原样"}
                      onClick={() => run(updateCategory(sel.id, { enabled: !sel.enabled }), sel.enabled ? "已停用「" + sel.name + "」" : "已启用「" + sel.name + "」", "启停分类")}
                    >{sel.enabled ? "停用" : "启用"}</button>
                  </div>

                  {selParent && (
                    <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
                      <span className="hint">移动到另一个一级分类</span>
                      <select style={{ maxWidth: "220px" }} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                        <option value="">选择目标一级分类…</option>
                        {tops.filter((t) => t.id !== sel.parentId && t.id !== UNCATEGORIZED_ID).map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                      <button
                        className="btn tiny" disabled={busy || !moveTo}
                        title="POST /api/categories/:id/move —— ID 保持不变（ID 是稳定标识）"
                        onClick={() => run(moveCategory(sel.id, moveTo), "已移动「" + sel.name + "」到目标一级分类", "移动分类", () => setMoveTo(""))}
                      >移动</button>
                    </div>
                  )}

                  {sel.parentId === null && (
                    <div>
                      <div className="hint" style={{ marginBottom: "4px" }}>子分类（{(sel.children ?? []).length}）</div>
                      <div className="cat-manager-list">
                        {[...(sel.children ?? [])].sort(bySort).map((c) => (
                          <div key={c.id} className={"cat-mgr-row sub" + (selId === c.id ? " on" : "")}>
                            <button className="nm link" onClick={() => setSelId(c.id)} title={"编辑 " + c.name}>{c.name}</button>
                            <span className="n">{c.itemCount}</span>
                            {c.builtin && <span className="mark">系统</span>}
                            {!c.enabled && <span className="mark off">停用</span>}
                            <span className="spacer" />
                            <button className="btn tiny" disabled={busy} onClick={() => shift(c, -1)} title="上移">↑</button>
                            <button className="btn tiny" disabled={busy} onClick={() => shift(c, 1)} title="下移">↓</button>
                            <button className="btn tiny" disabled={busy || c.builtin} onClick={() => run(updateCategory(c.id, { enabled: !c.enabled }), c.enabled ? "已停用「" + c.name + "」" : "已启用「" + c.name + "」", "启停子分类")}>{c.enabled ? "停用" : "启用"}</button>
                            <button className="btn tiny danger" disabled={busy || c.builtin} title={c.builtin ? "系统分类不可删除（删除会影响已归属的素材）" : "删除前会显示影响面并要求二次确认"} onClick={() => openImpact(c, "delete")}>删除</button>
                          </div>
                        ))}
                        {(sel.children ?? []).length === 0 && <div className="hint">这个一级分类还没有子分类。</div>}
                      </div>
                      <div className="row" style={{ gap: "5px", marginTop: "6px" }}>
                        <input type="text" placeholder="新增子分类名称" value={newSub} onChange={(e) => setNewSub(e.target.value)} />
                        <button
                          className="btn tiny" disabled={busy || !newSub.trim()}
                          onClick={() => run(createCategory({ name: newSub.trim(), parentId: sel.id }), "已新增子分类：" + newSub.trim(), "新增子分类", () => setNewSub(""))}
                        >新增子分类</button>
                      </div>
                    </div>
                  )}

                  <div className="cat-danger">
                    <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
                      <span className="hint">危险操作（都会先显示影响面并二次确认；绝不删除素材）：</span>
                      <button className="btn tiny danger" disabled={busy || sel.builtin} title={sel.builtin ? "系统分类不可删除（删了下次启动会按 ID 播种复活，而且会影响已归属素材）" : "先 GET impact，再选择转移目标"} onClick={() => openImpact(sel, "delete")}>删除分类…</button>
                      <button className="btn tiny danger" disabled={busy || sel.builtin} title={sel.builtin ? "系统分类不能作为合并源（可以合并到系统分类）" : "把本分类的素材与建议迁到同级分类，然后删除本分类"} onClick={() => openImpact(sel, "merge")}>合并到…</button>
                    </div>
                    {sel.builtin && <div className="hint" style={{ marginTop: "3px" }}>系统分类（builtin=true）不可删除、不可停用；如需隐藏请改用「停用」—— 它也必须永远可访问。</div>}
                  </div>

                  {/* 影响面确认面板：子分类行上的「删除」按钮也会走到这里（impact.id 未必等于当前选中的 sel.id） */}
                  {impact && (
                    <div className="cat-confirm">
                      <b>{impact.kind === "delete" ? "确认删除" : "确认合并"}「{impact.name}」？</b>
                      <div className="hint">
                        影响面（GET /api/categories/{impact.id}/impact）：素材 <b>{impact.data.items}</b> 条
                        {typeof impact.data.direct === "number" ? "（直接归属 " + impact.data.direct + "）" : ""} · 子分类 <b>{impact.data.subs}</b> 个 ·
                        待确认建议引用 <b>{impact.data.suggestions}</b> 条。删除/合并不会删除任何素材或文件。
                      </div>
                      {impact.kind === "delete" ? (
                        <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
                          <span className="hint">这些素材转移到</span>
                          <select style={{ maxWidth: "240px" }} value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                            <option value="none">未分类（清空归属）</option>
                            {tops.filter((t) => t.id !== impact.id).map((t) => (
                              <option key={t.id} value={t.id}>{t.builtin ? "（一级）" : ""}{t.name}</option>
                            ))}
                            {tops.flatMap((t) => (t.children ?? []).filter((c) => c.id !== impact.id).map((c) => (
                              <option key={c.id} value={c.id}>{t.name} › {c.name}</option>
                            )))}
                          </select>
                          <button className="btn tiny danger" disabled={busy} onClick={doDelete}>确认删除</button>
                          <button className="btn tiny" disabled={busy} onClick={() => setImpact(null)}>取消</button>
                        </div>
                      ) : (
                        <div className="row wrap" style={{ gap: "5px", alignItems: "center" }}>
                          <span className="hint">合并到（同级）</span>
                          <select style={{ maxWidth: "240px" }} value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                            <option value="">选择目标…</option>
                            {sameLevel(sel).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                          </select>
                          <button className="btn tiny danger" disabled={busy || !mergeInto} onClick={doMerge}>确认合并</button>
                          <button className="btn tiny" disabled={busy} onClick={() => setImpact(null)}>取消</button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="drawer-body">
            <div className="left">
              <div className="row" style={{ gap: "5px" }}>
                <input type="text" placeholder="新标签名称" value={tagName} onChange={(e) => setTagName(e.target.value)} />
                <input type="color" style={{ width: "42px", padding: "1px" }} value={tagColor} onChange={(e) => setTagColor(e.target.value)} title="标签颜色（不是身份，改名/改色都不影响关联）" />
                <button
                  className="btn tiny" disabled={busy || !tagName.trim()}
                  title="POST /api/tags —— 同名幂等：已存在就直接返回那个，不重复创建"
                  onClick={() => run(createTag({ name: tagName.trim(), color: tagColor }), "已新建标签：" + tagName.trim(), "新建标签", () => setTagName(""))}
                >新建</button>
              </div>
              <div className="hint">标签身份 = (namespace, name)，颜色不是身份；删除标签只删关联，不删素材。</div>
            </div>
            <div className="right">
              <div className="cat-manager-list">
                {selectedTags.map((t) => {
                  const draft = tagEdits[t.id] ?? { name: t.name, color: t.color ?? "#4da3ff" };
                  const dirty = draft.name !== t.name || draft.color !== (t.color ?? "#4da3ff");
                  return (
                    <div className="tag-mgr-row" key={t.id}>
                      <input
                        type="color" value={draft.color} style={{ width: "36px", padding: "1px" }}
                        onChange={(e) => setTagEdits((m) => ({ ...m, [t.id]: { ...draft, color: e.target.value } }))}
                        title="改色"
                      />
                      <input
                        type="text" value={draft.name}
                        onChange={(e) => setTagEdits((m) => ({ ...m, [t.id]: { ...draft, name: e.target.value } }))}
                      />
                      <span className="n" title="使用该标签的素材数">{t.itemCount ?? "?"}</span>
                      {t.namespace && <span className="mark">{t.namespace}</span>}
                      <button
                        className="btn tiny" disabled={busy || !dirty || !draft.name.trim()}
                        title="PATCH /api/tags/:id —— 改名后素材关联按 id 自动跟随"
                        onClick={() => run(updateTag(t.id, { name: draft.name.trim(), color: draft.color }), "已更新标签：" + draft.name.trim(), "更新标签")}
                      >保存</button>
                      {tagDeleteId === t.id ? (
                        <>
                          <span className="hint">确认删除？（{t.itemCount ?? 0} 条素材的该标签关联会被移除，素材不受影响）</span>
                          <button className="btn tiny danger" disabled={busy} onClick={() => run(deleteTag(t.id), "已删除标签：" + t.name, "删除标签", () => setTagDeleteId(null))}>确认删除</button>
                          <button className="btn tiny" onClick={() => setTagDeleteId(null)}>取消</button>
                        </>
                      ) : (
                        <button className="btn tiny danger" disabled={busy} onClick={() => setTagDeleteId(t.id)}>删除</button>
                      )}
                    </div>
                  );
                })}
                {!selectedTags.length && <div className="hint">还没有标签（GET /api/tags 返回空）。</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
