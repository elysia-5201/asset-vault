import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AvatarMatch, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";
import { parseEvidence, shortenPath } from "../util";

export function Badge(props: { tone?: "ok" | "warn" | "bad" | "busy" | "muted" | "violet" | ""; children: ReactNode; title?: string }) {
  return <span className={"badge " + (props.tone ?? "")} title={props.title}>{props.children}</span>;
}

export function Section(props: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <h4>{props.title}<span className="spacer" />{props.right}</h4>
      {props.children}
    </div>
  );
}

export function Spinner() { return <span className="spin" aria-label="加载中" />; }

/**
 * 证据来源一行：默认只显示"哪几类证据、各多少条"，点开才看前几条。
 * 起因：一条 avatar 的 evidence 里可能有 100+ 条 unitypackage 路径，原样铺开会把面板淹掉。
 */
export function EvidenceLine(props: { name: string; source?: string | null; evidence?: string | null; prefix?: string | null; confidence?: number | null }) {
  const [open, setOpen] = useState(false);
  const { groups } = useMemo(() => parseEvidence(props.evidence), [props.evidence]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  // 证据很少时直接铺一行文字，别为了 1 条证据给一排标签 + 展开按钮
  const inline = total > 0 && total <= 2 && groups.every((g) => g.items.every((t) => t.length <= 60));
  return (
    <div className="evidence">
      <div className="row wrap" style={{ gap: "6px", alignItems: "center" }}>
        <b>@{props.name}</b>
        {props.prefix ? <span className="hint" title="entry_prefix">prefix={shortenPath(props.prefix, 40)}</span> : null}
        <span className="hint">source={props.source ?? "—"}</span>
        {props.confidence !== undefined && props.confidence !== null ? <span className="hint">conf {props.confidence.toFixed(2)}</span> : null}
        {inline && <span className="hint">{groups.map((g) => g.key + ": " + g.items.join("、")).join(" · ")}</span>}
        <span className="spacer" />
        {!inline && groups.map((g) => (
          <span className="tag-chip" key={g.key} title={g.items.slice(0, 3).map((t) => shortenPath(t, 160)).join("\n")}>{g.key} × {g.items.length}</span>
        ))}
        {!total && <span className="hint">API 未返回 evidence 字段</span>}
        {!inline && total > 0 && <button className="btn tiny" onClick={() => setOpen((v) => !v)}>{open ? "▾ 收起" : "▸ 展开 " + total + " 条"}</button>}
      </div>
      {open && (
        <div style={{ marginTop: "4px" }}>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: "3px" }}>
              <div className="hint">{g.key}（{g.items.length} 条）</div>
              {g.items.slice(0, 5).map((t, i) => (
                <div key={i} className="hint mono" style={{ fontSize: "10.5px", wordBreak: "break-all" }}>{shortenPath(t)}</div>
              ))}
              {g.items.length > 5 && <div className="hint">…还有 {g.items.length - 5} 条（点上方标题可复制整段 JSON）</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface Toast { id: number; kind: "ok" | "bad" | "info"; text: string }

export function ToastHost(props: { toasts: Toast[]; onClose: (id: number) => void }) {
  return (
    <div className="toast-wrap">
      {props.toasts.map((t) => (
        <div key={t.id} className={"toast " + (t.kind === "info" ? "" : t.kind)} onClick={() => props.onClose(t.id)} title="点击关闭">
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const SITE_LABEL: Record<SourceSite, string> = {
  booth: "BOOTH", gumroad: "Gumroad", unity_asset_store: "Unity Asset Store", itch: "itch.io", other: "其它", local: "本地",
};
export const STATUS_LABEL: Record<ItemStatus, string> = { inbox: "待整理", active: "在库", archived: "归档", trashed: "回收站" };
export const CONTAINER_LABEL: Record<ContainerKind, string> = { zip: "zip", "7z": "7z", rar: "rar", unitypackage: "unitypackage", dir: "目录", file: "单文件" };
export const MATCH_LABEL: Record<AvatarMatch, string> = { any: "任一", all: "全部", exclude: "排除" };

export const SITES: SourceSite[] = ["booth", "gumroad", "unity_asset_store", "itch", "other", "local"];
export const STATUSES: ItemStatus[] = ["inbox", "active", "archived", "trashed"];
export const CONTAINERS: ContainerKind[] = ["zip", "7z", "rar", "unitypackage", "dir", "file"];
