/**
 * 「加入搭配清单…」按钮（avatar-loadouts spec §7.1；P3-T4）。
 *
 * 语义：用户显式选模型 → 选清单 → 点「添加」才写 POST。
 * - 不自动从条目的适配模型（条目卡上的适配模型字段）推断模型，也不在挂载时自动添加。
 * - 模型由父传入（ItemDetail 挂载时把当前选中模型传进来）；未选模型只提示，不猜。
 * - 成功后刷新真实 server 响应并回调父；按钮不会永久 disabled。
 * 父挂载（ItemDetail 里的按钮位置）归 P1-T5/task34；本组件只提供可接 props。
 */
import { useEffect, useState } from "react";
import { addLoadoutItems, describeError, listAvatarLoadouts } from "../api";
import type { Loadout } from "../types";
import { Spinner } from "./ui";

export interface AddToLoadoutButtonProps {
  itemId: number;
  /** 用户显式选择的模型；null = 未选（只提示，不自动推断）。 */
  avatarId: number | null;
  /** 父已加载的清单可传入；缺省按 avatarId 自取。 */
  loadouts?: Loadout[];
  onAdded?: (r: { loadoutId: number; added: number; revived: number; existing: number }) => void;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
  label?: string;
}

export function AddToLoadoutButton(props: AddToLoadoutButtonProps) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Loadout[]>(props.loadouts ?? []);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open || props.avatarId === null) return;
    if (props.loadouts) { setList(props.loadouts); return; }
    let alive = true;
    setErr("");
    listAvatarLoadouts(props.avatarId)
      .then((res) => { if (alive) setList(res.loadouts); })
      .catch((e) => { if (alive) setErr(describeError(e)); });
    return () => { alive = false; };
  }, [open, props.avatarId, props.loadouts]);

  /** 唯一写入口：用户点「添加」后按所选清单提交本条目。 */
  const add = () => {
    if (props.avatarId === null || picked === null) return;
    setBusy(true); setErr("");
    addLoadoutItems(picked, { itemIds: [props.itemId] })
      .then((r) => {
        props.onToast?.("ok", "已加入清单 #" + picked + "（新增 " + r.added + "，复活 " + r.revived + "，已存在 " + r.existing + "）");
        props.onAdded?.({ loadoutId: picked, added: r.added, revived: r.revived, existing: r.existing });
        setOpen(false);
      })
      .catch((e) => { const m = describeError(e); setErr(m); props.onToast?.("bad", m); })
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <button className="btn tiny" onClick={() => setOpen((v) => !v)}>{props.label ?? "加入搭配清单…"}</button>
      {open && (
        <div className="row wrap" style={{ gap: "6px", marginTop: "4px" }}>
          {props.avatarId === null
            ? <span className="hint">先在左侧头像轨选择模型（不自动从条目适配模型推断）</span>
            : (
              <>
                <select value={picked ?? ""} onChange={(e) => setPicked(e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">选择清单…</option>
                  {list.map((l) => <option key={l.id} value={l.id}>{l.name}（{l.itemCount}）</option>)}
                </select>
                <button className="btn tiny" disabled={picked === null || busy} onClick={add}>{busy ? <Spinner /> : "添加"}</button>
                <button className="btn tiny ghost" onClick={() => setOpen(false)}>取消</button>
              </>
            )}
          {err && <span className="hint" style={{ color: "var(--bad)" }}>{err}</span>}
        </div>
      )}
    </div>
  );
}
