import type { AvatarMatch } from "@core/contracts";
import type { AvatarCard } from "../types";

function isUrlLike(s: string | null): boolean {
  return !!s && /^(https?:|data:|blob:|\/)/i.test(s);
}

export function AvatarRail(props: {
  avatars: AvatarCard[];
  loading: boolean;
  selected: number[];
  onToggle: (id: number) => void;
  onClear: () => void;
  ownedOnly: boolean;
  onOwnedOnly: (v: boolean) => void;
  match: AvatarMatch;
  onMatch: (m: AvatarMatch) => void;
  hits: number;
}) {
  const sel = new Set(props.selected);
  const shown = props.ownedOnly ? props.avatars.filter((a) => a.owned) : props.avatars;
  return (
    <>
      <div className="pane-head">
        <h2>头像轨</h2>
        <span className="hint">{shown.length}</span>
      </div>
      <div className="pane-body" style={{ display: "flex", flexDirection: "column", gap: "8px", borderBottom: "1px solid var(--line)" }}>
        <label className="chk" title="只看已拥有（owned=1）的头像">
          <input type="checkbox" checked={props.ownedOnly} onChange={(e) => props.onOwnedOnly(e.target.checked)} />
          只看已拥有
        </label>
        <div className="row" title="多选头像时的语义：任一 / 全部">
          <span className="hint">匹配</span>
          <div className="seg">
            <button className={props.match === "any" ? "on" : ""} onClick={() => props.onMatch("any")}>ANY</button>
            <button className={props.match === "all" ? "on" : ""} onClick={() => props.onMatch("all")}>ALL</button>
          </div>
          <span className="spacer" />
          <span className="hint">已选 {props.selected.length}</span>
        </div>
        <div className="row">
          <span className="hint">命中条目 <b style={{ color: "var(--fg)" }}>{props.hits}</b></span>
          <span className="spacer" />
          <button className="btn tiny ghost" disabled={!props.selected.length} onClick={props.onClear}>清空</button>
        </div>
      </div>
      <div className="col-scroll">
        {props.loading && <div className="empty"><span className="spin" /> 载入头像…</div>}
        {!props.loading && !shown.length && <div className="empty">没有匹配的头像</div>}
        <div className="avatar-list">
          {shown.map((a) => {
            const on = sel.has(a.id);
            return (
              <button
                key={a.id}
                className={"avatar-row" + (on ? " on" : "")}
                onClick={() => props.onToggle(a.id)}
                title={`${a.name}（${a.kind}）\n别名：${a.aliases.join("、") || "—"}\n拥有：${a.owned ? "是" : "否"}\n命中条目：${a.itemCount}`}
              >
                {isUrlLike(a.coverPath)
                  ? <img className="avatar-cover" src={a.coverPath as string} alt={a.name} loading="lazy" />
                  : <span className="avatar-cover" style={{ display: "grid", placeItems: "center", fontWeight: 700, color: "var(--fg-dim)" }}>{a.name.slice(0, 2)}</span>}
                <span style={{ minWidth: 0 }}>
                  <span className="avatar-name" style={{ display: "block" }}>{a.name}</span>
                  <span className="avatar-sub" style={{ display: "block" }}>
                    {a.kind} · {a.aliases.length} 别名
                  </span>
                </span>
                <span className="row" style={{ gap: "6px" }}>
                  <span className={a.owned ? "owned-dot" : "unowned-dot"} title={a.owned ? "已拥有" : "未拥有"} />
                  <span className="badge" title="命中条目数">{a.itemCount}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
