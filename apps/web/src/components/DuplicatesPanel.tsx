import { useCallback, useEffect, useState } from "react";
import { describeError, getDuplicateGroups, recomputeSignatures } from "../api";
import type { DuplicateGroup } from "../types";
import { formatBytes, shortenPath } from "../util";
import { Badge, Spinner } from "./ui";

/** 库级查重阈值（按契约 min 是 0..1）。 */
const MIN_OPTIONS = [0.9, 0.95, 0.98] as const;

const pct = (v: number): string => (v * 100).toFixed(1) + "%";

/**
 * 「查重」面板：库级疑似重复组。
 * 打开时按当前阈值拉一次 /duplicates，阈值变化重拉；「重算签名」触发 POST /duplicates/recompute。
 * 后端端点还没上线时（404 / mock 模式）只显示空态 + 一行提示，不抛未捕获异常。
 */
export function DuplicatesPanel(props: {
  onClose: () => void;
  onOpenItem: (itemId: number) => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const [min, setMin] = useState<number>(0.9);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [recomputing, setRecomputing] = useState(false);
  /** 重算完成后自增，强制按当前阈值重拉一次。 */
  const [reloadSeq, setReloadSeq] = useState(0);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true); setErr("");
    getDuplicateGroups(min)
      .then((r) => { if (alive) setGroups(r.groups); })
      .catch((e) => { if (alive) { setGroups([]); setErr(describeError(e)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [min, reloadSeq]);

  useEffect(() => load(), [load]);

  const doRecompute = () => {
    if (recomputing) return;
    setRecomputing(true);
    recomputeSignatures()
      .then((r) => {
        props.onToast("ok", "重算完成：扫描 " + r.scanned + " 个资产，更新 " + r.updated + " 个签名");
        setReloadSeq((n) => n + 1);
      })
      .catch((e) => props.onToast("bad", "重算失败：" + describeError(e)))
      .finally(() => setRecomputing(false));
  };

  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="backdrop" onClick={props.onClose}>
      <div className="drawer dup-panel" role="dialog" aria-label="查重" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>查重 · 库级疑似重复</h3>
          <Badge tone="muted">{min === 0.9 ? "≥ 90%" : min === 0.95 ? "≥ 95%" : "≥ 98%"}</Badge>
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>关闭</button>
        </div>
        <div className="dup-body">
          <div className="row wrap" style={{ alignItems: "center", gap: "6px" }}>
            <span className="hint">最小相似度</span>
            <div className="seg">
              {MIN_OPTIONS.map((v) => (
                <button key={v} className={min === v ? "on" : ""} onClick={() => setMin(v)}>{Math.round(v * 100)}%</button>
              ))}
            </div>
            <span className="spacer" />
            {loading && <Spinner />}
            <button className="btn tiny" disabled={recomputing} title="重新计算全部资产的重复签名（POST /api/duplicates/recompute）" onClick={doRecompute}>
              {recomputing ? "重算中…" : "重算签名"}
            </button>
          </div>
          <div className="hint">
            按资产内容签名聚类：同一组内的条目互相疑似重复。点条目可直接打开它的详情；阈值越高越严格。
          </div>

          {err && <div className="notice">查重接口暂不可用（后端可能还没上线这个端点）：{err}</div>}

          {!loading && !groups.length && (
            <div className="empty">
              没有发现相似度 ≥ {Math.round(min * 100)}% 的重复
              <div className="hint" style={{ marginTop: "6px" }}>
                新导入的素材可能还没算签名，点右上「重算签名」再试。
              </div>
            </div>
          )}

          {groups.map((g) => (
            <div className="dup-group" key={g.key}>
              <div className="dup-group-head">
                <b>重复组 · 相似度 {pct(g.similarity)}</b>
                <span className="hint">{g.items.length} 条</span>
                <span className="spacer" />
                <span className="hint mono" title={g.key}>{shortenPath(g.key, 48)}</span>
              </div>
              {g.items.map((it) => (
                <button
                  className="dup-item"
                  key={g.key + ":" + it.itemId + ":" + it.assetId}
                  title={it.path}
                  onClick={() => props.onOpenItem(it.itemId)}
                >
                  <span className="mono">#{it.itemId}</span>
                  <span className="t">{it.title || "(无标题)"}</span>
                  <span className="hint">{it.versionKey ? "版本 " + it.versionKey : "无版本"} · {formatBytes(it.size)}</span>
                </button>
              ))}
            </div>
          ))}

          {groups.length > 0 && (
            <div className="hint">共 {groups.length} 组 / {totalItems} 条 · 相似度 ≥ {Math.round(min * 100)}%</div>
          )}
        </div>
      </div>
    </div>
  );
}
