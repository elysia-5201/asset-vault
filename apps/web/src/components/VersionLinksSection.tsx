/**
 * 版本关系面板（import-precheck spec §8.2）。
 *
 * 只按已准路由读写：GET/POST/PATCH/DELETE /api/items/:id/version-links。
 * 人工建立的关系是 candidate（需确认），不冒充 proven；缺版本键/证据时显示「未知」，
 * 不写「已验证版本 / 确认是新版本 / 实时磁盘检查」。确认/更正/撤销都带 expectedVersion，
 * 409 明确提示「已被其他操作修改，请刷新」。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiError, createVersionLink, deleteVersionLink, describeError, getItem, listVersionLinks, patchVersionLink,
  type VersionLinkBasis, type VersionLinkRelation, type VersionLinkState,
} from "../api";
import type { VersionLink } from "../types";
import { Badge, Section, Spinner } from "./ui";

const RELATION_LABEL: Record<VersionLinkRelation, string> = {
  a_newer: "A 较新", b_newer: "B 较新", same: "同版本", companion: "配套文件",
};
const BASIS_LABEL: Record<VersionLinkBasis, string> = { filename: "文件名", title: "标题", manual: "人工" };
const STATE_LABEL: Record<VersionLinkState, string> = {
  candidate: "候选（需确认）", confirmed: "已确认", revoked: "已撤销",
};
const RELATIONS: VersionLinkRelation[] = ["a_newer", "b_newer", "same", "companion"];

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** evidence 里的版本键：只认显式字符串；缺就「未知」，不猜、不把候选当已证实。 */
function versionKeysOf(evidence: unknown): { incoming: string | null; existing: string | null } {
  if (!evidence || typeof evidence !== "object") return { incoming: null, existing: null };
  const e = evidence as Record<string, unknown>;
  return {
    incoming: typeof e.incomingKey === "string" && e.incomingKey !== "" ? e.incomingKey : null,
    existing: typeof e.existingKey === "string" && e.existingKey !== "" ? e.existingKey : null,
  };
}

export function VersionLinksSection(props: {
  itemId: number;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
  onChanged?: () => void;
}) {
  const [links, setLinks] = useState<VersionLink[]>([]);
  const [total, setTotal] = useState(0);
  const [assets, setAssets] = useState<{ id: number; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState<{ a: string; b: string; relation: VersionLinkRelation }>({ a: "", b: "", relation: "a_newer" });
  const [editing, setEditing] = useState<{ id: number; relation: VersionLinkRelation } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const toast = (kind: "ok" | "bad" | "info", text: string) => props.onToast?.(kind, text);

  const load = useCallback(() => {
    setLoading(true); setError("");
    listVersionLinks(props.itemId)
      .then((res) => { setLinks(res.links); setTotal(res.total); })
      .catch((e) => setError(describeError(e)))
      .finally(() => setLoading(false));
    // 资产列表只用于「新建候选」的下拉：读失败不影响已有关联的展示。
    getItem(props.itemId)
      .then((detail) => setAssets((detail.assets ?? []).map((a) => ({ id: a.id, path: a.path }))))
      .catch(() => setAssets([]));
  }, [props.itemId]);

  useEffect(() => { load(); }, [load]);

  /** 统一执行：409 明确「已被其他操作修改，请刷新」并重载（CAS 失败后本地 version 已过期）。 */
  const run = (key: string, p: Promise<unknown>, okText: string, onOk?: () => void) => {
    setBusy(key);
    p.then(() => { toast("ok", okText); onOk?.(); load(); props.onChanged?.(); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          toast("bad", "已被其他操作修改，请刷新（" + describeError(e) + "）");
          load();
        } else toast("bad", describeError(e));
      })
      .finally(() => setBusy(""));
  };

  const confirmLink = (l: VersionLink) =>
    run("confirm:" + l.id, patchVersionLink(props.itemId, l.id, { state: "confirmed", expectedVersion: l.version }), "已确认版本关系 #" + l.id);

  const revokeLink = (l: VersionLink) =>
    run("revoke:" + l.id, patchVersionLink(props.itemId, l.id, { state: "revoked", expectedVersion: l.version }), "已撤销版本关系 #" + l.id);

  const correctLink = (l: VersionLink) => {
    if (!editing || editing.id !== l.id) return;
    run("correct:" + l.id, patchVersionLink(props.itemId, l.id, { relation: editing.relation, expectedVersion: l.version }), "已更正版本关系 #" + l.id);
    setEditing(null);
  };

  const removeLink = (l: VersionLink) => {
    setConfirmDelete(null);
    run("delete:" + l.id, deleteVersionLink(props.itemId, l.id), "已删除版本关系记录 #" + l.id);
  };

  const a = Number(form.a);
  const b = Number(form.b);
  const canCreate = Number.isInteger(a) && a > 0 && Number.isInteger(b) && b > 0 && a !== b;

  const create = () => {
    if (!canCreate) { toast("bad", "请选择两个不同的资产"); return; }
    run(
      "create",
      createVersionLink(props.itemId, { assetAId: a, assetBId: b, relation: form.relation, basis: "manual" }),
      "已建候选版本关系（需人工确认）",
      () => setForm((s) => ({ ...s, a: "", b: "" })),
    );
  };

  return (
    <Section
      title={<>版本关系 {total > 0 && <Badge tone="muted">{total}</Badge>}</>}
      right={<button className="btn tiny" onClick={load} disabled={loading}>{loading ? "…" : "刷新"}</button>}
    >
      {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}
      {!loading && !error && links.length === 0 && (
        <div className="hint">还没有版本关系记录。人工建立的是候选（需确认），不是已验证版本。</div>
      )}
      {links.map((l) => {
        const keys = versionKeysOf(l.evidence);
        return (
          <div key={l.id} style={{ borderTop: "1px solid var(--line-soft)", padding: "6px 0" }}>
            <div className="row wrap" style={{ gap: "6px" }}>
              <Badge tone={l.state === "confirmed" ? "ok" : l.state === "revoked" ? "muted" : "warn"}>{STATE_LABEL[l.state]}</Badge>
              <span className="mono" style={{ fontSize: "11px", wordBreak: "break-all" }}>
                {baseName(l.assets.a.path)} ↔ {baseName(l.assets.b.path)}
              </span>
              <span className="hint">#{l.id} · v{l.version}</span>
              <span className="spacer" />
              {l.state !== "confirmed" && (
                <button className="btn tiny" disabled={busy !== ""} onClick={() => confirmLink(l)}>确认</button>
              )}
              <button className="btn tiny" disabled={busy !== ""} onClick={() => setEditing({ id: l.id, relation: l.relation })}>更正…</button>
              {l.state !== "revoked" && (
                <button className="btn tiny" disabled={busy !== ""} onClick={() => revokeLink(l)}>撤销</button>
              )}
              {confirmDelete === l.id
                ? <button className="btn tiny danger" disabled={busy !== ""} onClick={() => removeLink(l)}>确认删除？</button>
                : <button className="btn tiny danger" disabled={busy !== ""} onClick={() => setConfirmDelete(l.id)}>删除记录</button>}
            </div>
            <div className="hint" style={{ marginTop: "2px" }}>
              关系：{RELATION_LABEL[l.relation]} · 依据：{BASIS_LABEL[l.basis]} · 版本键：{keys.incoming ?? "未知"} → {keys.existing ?? "未知"}
              {l.state === "candidate" ? " · 需人工确认" : ""}
            </div>
            {editing?.id === l.id && (
              <div className="row wrap" style={{ marginTop: "3px" }}>
                <select value={editing.relation} onChange={(e) => setEditing({ id: l.id, relation: e.target.value as VersionLinkRelation })}>
                  {RELATIONS.map((r) => <option key={r} value={r}>{RELATION_LABEL[r]}</option>)}
                </select>
                <button className="btn tiny" disabled={busy !== ""} onClick={() => correctLink(l)}>保存更正</button>
                <button className="btn tiny" onClick={() => setEditing(null)}>取消</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="row wrap" style={{ marginTop: "8px" }}>
        <span className="hint">新建候选：</span>
        <select value={form.a} onChange={(e) => setForm((s) => ({ ...s, a: e.target.value }))}>
          <option value="">资产 A…</option>
          {assets.map((x) => <option key={x.id} value={x.id}>#{x.id} {baseName(x.path)}</option>)}
        </select>
        <select value={form.b} onChange={(e) => setForm((s) => ({ ...s, b: e.target.value }))}>
          <option value="">资产 B…</option>
          {assets.map((x) => <option key={x.id} value={x.id}>#{x.id} {baseName(x.path)}</option>)}
        </select>
        <select value={form.relation} onChange={(e) => setForm((s) => ({ ...s, relation: e.target.value as VersionLinkRelation }))}>
          {RELATIONS.map((r) => <option key={r} value={r}>{RELATION_LABEL[r]}</option>)}
        </select>
        <button className="btn tiny" disabled={!canCreate || busy !== ""} onClick={create}>{busy === "create" ? <Spinner /> : "建候选（人工）"}</button>
      </div>
      <div className="hint" style={{ marginTop: "3px" }}>人工候选 basis=manual；缺版本键或证据时显示「未知」，不声称已验证。</div>
    </Section>
  );
}
