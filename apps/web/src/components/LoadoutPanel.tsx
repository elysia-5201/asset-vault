/**
 * 搭配清单面板（avatar-loadouts spec §7.2；P3-T4）。
 *
 * 真实读写已准 9 端点（apps/server/src/http/routes/loadouts.ts）：
 * 清单选择/新建/改名/删除（确认「只删清单，不删素材」）、条目卡（标题/状态 chip/只读证据/备注）、
 * 移出（不删 item 与素材）、回收站开关、拖拽只提交可见行。
 *
 * 边界：
 * - 状态是手动声明（准备使用/已导入（手动）/已验证（手动）），证据只读；不一致只提示、不自动改写。
 * - counts 三口径分开：stateCounts（整份清单，含回收站条目）/ trashedCount / 当前列表 total。
 * - 改名/改状态/改备注都用详情里的数值 version 做 CAS；缺 version 就拒绝提交，不拿 0/undefined 兜底。
 * - 父挂载（AvatarRail 入口、ItemDetail 按钮）归 P1-T5/task34；本组件只提供可接 props，不假称已主 UI 可用。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiError, createLoadout, deleteLoadout, describeError, getLoadout, listAvatarLoadouts,
  patchLoadout, patchLoadoutItem, removeLoadoutItem, reorderLoadoutItems,
} from "../api";
import type { Loadout, LoadoutDetail, LoadoutItem, LoadoutState } from "../types";
import {
  conflictHint, countsCaption, evidenceLabel, evidenceMark, listTotalCaption,
  reorderPayload, stateLabel, visibleReorderIds,
} from "../loadout-view";
import { Badge, Section, Spinner } from "./ui";

const STATES: LoadoutState[] = ["planned", "imported", "verified"];

export interface LoadoutPanelProps {
  /** 当前模型（AvatarRail 选中项）；面板只读该模型的清单。 */
  avatarId: number;
  /** 父可指定初始清单；缺省选第一份。 */
  initialLoadoutId?: number | null;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
  /** 清单/条目变化后通知父刷新（例如头像轨计数）。 */
  onChanged?: () => void;
}

export function LoadoutPanel(props: LoadoutPanelProps) {
  const [loadouts, setLoadouts] = useState<Loadout[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(props.initialLoadoutId ?? null);
  const [detail, setDetail] = useState<LoadoutDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [dragId, setDragId] = useState<number | null>(null);

  const toast = (kind: "ok" | "bad" | "info", text: string) => props.onToast?.(kind, text);

  const loadList = useCallback(() => {
    setLoading(true); setError("");
    listAvatarLoadouts(props.avatarId)
      .then((res) => {
        setLoadouts(res.loadouts);
        setSelectedId((cur) => {
          if (cur !== null && res.loadouts.some((l) => l.id === cur)) return cur;
          const wanted = props.initialLoadoutId;
          if (wanted !== undefined && wanted !== null && res.loadouts.some((l) => l.id === wanted)) return wanted;
          return res.loadouts.length ? res.loadouts[0].id : null;
        });
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => setLoading(false));
  }, [props.avatarId, props.initialLoadoutId]);

  const loadDetail = useCallback(() => {
    // 清空选择时同时清掉旧错误横幅（否则删除清单后 404 文案会留在红条上）。
    if (selectedId === null) { setDetail(null); setError(""); return; }
    setLoading(true); setError("");
    // 只按 includeTrashedItems 取；不加未准 state 筛选（否则所见集合与 reorder 的可见集不一致）。
    // limit 取已准上限 500：默认 100 会静默截断，使 reorder 提交的可见集不完整（server 判 400）。
    getLoadout(selectedId, { includeTrashedItems: includeTrashed, limit: 500 })
      .then(setDetail)
      .catch((e) => setError(describeError(e)))
      .finally(() => setLoading(false));
  }, [selectedId, includeTrashed]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  /** 统一执行：409 明确「已被其他操作修改，请刷新」并重载（本地 version 已过期）。 */
  const run = (key: string, p: Promise<unknown>, okText: string, after?: () => void) => {
    setBusy(key);
    p.then(() => { toast("ok", okText); after?.(); loadList(); loadDetail(); props.onChanged?.(); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          toast("bad", "已被其他操作修改，请刷新（" + describeError(e) + "）");
          loadList(); loadDetail();
        } else toast("bad", describeError(e));
      })
      .finally(() => setBusy(""));
  };

  const create = () => {
    const name = newName.trim();
    if (!name) { toast("bad", "清单名不能为空"); return; }
    setBusy("create");
    createLoadout(props.avatarId, { name })
      .then((res) => {
        setNewName("");
        setSelectedId(res.loadout.id);
        toast("ok", "已新建清单「" + res.loadout.name + "」");
        loadList();
        props.onChanged?.();
      })
      .catch((e) => toast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const rename = () => {
    if (!detail) return;
    const name = renaming.trim();
    if (!name) { toast("bad", "清单名不能为空"); return; }
    const version = detail.loadout.version;
    // 真正 CAS：必须用详情里的数值 version；缺就拒绝，不拿 0/undefined 兜底。
    if (typeof version !== "number") { toast("bad", "缺少清单 version，先刷新详情再改名"); return; }
    run("rename", patchLoadout(detail.loadout.id, { name, expectedVersion: version }), "已改名为「" + name + "」", () => setRenaming(""));
  };

  /**
   * 删除清单：成功后只清选择/详情/错误并刷新列表，**不走 run 的详情重载** ——
   * run 的 loadDetail 闭包持有删除前的 selectedId，会 GET 已删 id 触发 404 横幅。
   */
  const removeLoadout = (l: Loadout) => {
    setConfirmDelete(null);
    setBusy("delete:" + l.id);
    return deleteLoadout(l.id)
      .then(() => {
        toast("ok", "已删除清单「" + l.name + "」（只删清单，不删素材）");
        if (selectedId === l.id) { setSelectedId(null); setDetail(null); setError(""); }
        loadList();
        props.onChanged?.();
      })
      .catch((e) => toast("bad", describeError(e)))
      .finally(() => setBusy(""));
  };

  const setState = (it: LoadoutItem, state: LoadoutState) => {
    if (!detail) return;
    run("state:" + it.itemId, patchLoadoutItem(detail.loadout.id, it.itemId, { state, expectedVersion: it.version }),
      "已改为「" + stateLabel(state) + "」（手动声明）");
  };

  const saveNote = (it: LoadoutItem) => {
    if (!detail) return;
    const raw = noteDraft[it.itemId] ?? it.note ?? "";
    const note = raw.trim();
    run("note:" + it.itemId, patchLoadoutItem(detail.loadout.id, it.itemId, { note: note === "" ? null : note, expectedVersion: it.version }),
      "备注已保存（本清单内独立）");
  };

  const removeItem = (it: LoadoutItem) => {
    if (!detail) return;
    run("remove:" + it.itemId, removeLoadoutItem(detail.loadout.id, it.itemId), "已移出清单（条目与素材都保留）");
  };

  /** 拖拽：只在当前可见行内换位，提交 visibleIds + hiddenIds=[]（不先加载隐藏行）。 */
  const dropOn = (targetId: number) => {
    if (!detail || dragId === null) return;
    // 截断门（handler 侧）：只显示前 limit 行时，提交的可见集不完整，server 会判 400；直接拒绝。
    if (detail.total > detail.items.length) {
      setDragId(null);
      toast("bad", "列表被截断（显示 " + detail.items.length + " / 共 " + detail.total + " 条），不能拖拽排序");
      return;
    }
    const ids = visibleReorderIds(detail.items);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = ids.slice();
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    run("reorder", reorderLoadoutItems(detail.loadout.id, reorderPayload(next, [])), "顺序已保存");
  };

  const selected = loadouts.find((l) => l.id === selectedId) ?? null;
  // 截断门（属性侧）：total > items.length 说明只拿到前 limit 行，拖拽会提交不完整可见集。
  const truncated = detail !== null && detail.total > detail.items.length;

  return (
    <Section
      title={<>搭配清单 {loadouts.length > 0 && <Badge tone="muted">{loadouts.length}</Badge>}</>}
      right={<button className="btn tiny" onClick={() => { loadList(); loadDetail(); }} disabled={loading}>{loading ? "…" : "刷新"}</button>}
    >
      {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}

      <div className="row wrap" style={{ gap: "6px" }}>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value === "" ? null : Number(e.target.value))}
          title="该模型内的多份清单"
        >
          <option value="">选择清单…</option>
          {loadouts.map((l) => <option key={l.id} value={l.id}>{l.name}（{l.itemCount}）</option>)}
        </select>
        <input value={newName} placeholder="新清单名（1..80）" onChange={(e) => setNewName(e.target.value)} />
        <button className="btn tiny" disabled={busy !== ""} onClick={create}>{busy === "create" ? <Spinner /> : "新建"}</button>
        <label className="chk" title="回收站 item 默认隐藏；打开后可见并标「回收站」">
          <input type="checkbox" checked={includeTrashed} onChange={(e) => setIncludeTrashed(e.target.checked)} />
          显示回收站
        </label>
      </div>

      {!loading && !error && loadouts.length === 0 && (
        <div className="hint">这个模型还没有搭配清单。新建一份，再从条目详情「加入搭配清单…」添加。</div>
      )}

      {selected && (
        <div className="row wrap" style={{ gap: "6px", marginTop: "6px" }}>
          <b>{selected.name}</b>
          <span className="hint">v{selected.version ?? "?"} · 条目 {selected.itemCount}</span>
          <span className="spacer" />
          <input value={renaming} placeholder="改名…" onChange={(e) => setRenaming(e.target.value)} />
          <button className="btn tiny" disabled={busy !== ""} onClick={rename}>改名</button>
          {confirmDelete === selected.id
            ? <button className="btn tiny danger" disabled={busy !== ""} onClick={() => removeLoadout(selected)}>确认删除清单？（只删清单，不删素材）</button>
            : <button className="btn tiny danger" disabled={busy !== ""} onClick={() => setConfirmDelete(selected.id)}>删除清单</button>}
        </div>
      )}

      {detail && (
        <>
          <div className="hint" style={{ marginTop: "4px" }}>
            {countsCaption({ stateCounts: detail.stateCounts, trashedCount: detail.trashedCount })}
          </div>
          <div className="hint">
            {listTotalCaption(detail.total, { state: null, includeTrashed })}
            {detail.trashedCount > 0 && !includeTrashed ? " · 回收站条目默认隐藏" : ""}
          </div>

          {truncated && (
            <div className="hint" style={{ color: "var(--warn)" }}>
              列表被截断：只显示 {detail.items.length} / 共 {detail.total} 条，拖拽排序已禁用（不加载隐藏行绕过）。
            </div>
          )}

          {detail.items.length === 0 && <div className="hint">这份清单还没有条目。</div>}

          {detail.items.map((it) => {
            const hint = conflictHint(it.state, it.evidence);
            const trashed = it.item.status === "trashed";
            return (
              <div
                key={it.itemId}
                draggable={!truncated}
                onDragStart={() => setDragId(it.itemId)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(it.itemId)}
                style={{ borderTop: "1px solid var(--line-soft)", padding: "6px 0", opacity: trashed ? 0.75 : 1 }}
              >
                <div className="row wrap" style={{ gap: "6px" }}>
                  <span className="hint" title="拖拽排序（只提交当前可见行）">⋮⋮</span>
                  <b>{it.item.title}</b>
                  <Badge tone={it.state === "verified" ? "ok" : it.state === "imported" ? "warn" : "muted"}>{stateLabel(it.state)}</Badge>
                  {trashed && <Badge tone="bad">回收站</Badge>}
                  <span className="hint">#{it.itemId} · v{it.version}</span>
                  <span className="spacer" />
                  <select value={it.state} onChange={(e) => setState(it, e.target.value as LoadoutState)} title="清单状态（手动声明）">
                    {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
                  </select>
                  <button className="btn tiny danger" disabled={busy !== ""} onClick={() => removeItem(it)}>移出</button>
                </div>
                <div className="hint" style={{ marginTop: "2px" }}>
                  证据（只读）：{evidenceLabel("registered")} {evidenceMark(it.evidence.registered)} · {evidenceLabel("referenced")} {evidenceMark(it.evidence.referenced)} · {evidenceLabel("verified")} {evidenceMark(it.evidence.verified)}
                </div>
                {hint && <div className="hint" style={{ color: "var(--warn)" }}>{hint}</div>}
                <div className="row wrap" style={{ gap: "6px", marginTop: "3px" }}>
                  <input
                    value={noteDraft[it.itemId] ?? it.note ?? ""}
                    placeholder="备注（本清单内独立）"
                    onChange={(e) => setNoteDraft((s) => ({ ...s, [it.itemId]: e.target.value }))}
                  />
                  <button className="btn tiny" disabled={busy !== ""} onClick={() => saveNote(it)}>保存备注</button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </Section>
  );
}
