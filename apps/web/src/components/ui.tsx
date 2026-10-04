import { useEffect, useState, type ReactNode } from "react";
import type { AvatarMatch, ContainerKind, ItemStatus, SourceSite } from "@core/contracts";

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
