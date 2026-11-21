import { useRef, useState } from "react";
import type { AssetRow } from "@core/contracts";
import {
  describeError, getAssetRelocationCandidates, relocateMissingAsset, removeMissingAsset,
  type AssetRelocationCandidate,
} from "../api";

export function MissingAssetActions(props: {
  asset: AssetRow;
  onChanged: () => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const { asset } = props;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<AssetRelocationCandidate[] | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lookupVersion = useRef(0);

  const closeAction = () => {
    lookupVersion.current++;
    setLoading(false);
    setOpen(false);
    setConfirmRemove(false);
  };

  const askToRemove = () => {
    lookupVersion.current++;
    setLoading(false);
    setOpen(true);
    setConfirmRemove(true);
    setCandidates(null);
    setSelectedId(null);
    setReason("");
    setError("");
  };

  const findCandidates = async () => {
    const version = ++lookupVersion.current;
    setOpen(true);
    setLoading(true);
    setError("");
    setCandidates(null);
    setReason("");
    setSelectedId(null);
    setConfirmRemove(false);
    try {
      const result = await getAssetRelocationCandidates(asset.id);
      if (lookupVersion.current !== version) return;
      setCandidates(result.candidates);
      setReason(result.reason ?? "");
    } catch (e) {
      if (lookupVersion.current === version) setError(describeError(e));
    } finally {
      if (lookupVersion.current === version) setLoading(false);
    }
  };

  const doRelocate = async () => {
    if (!selected || !selectedId) return;
    setBusy(true);
    setError("");
    try {
      await relocateMissingAsset(asset.id, {
        expectedItemId: asset.item_id,
        expectedPath: asset.path,
        candidateId: selected.assetId,
        expectedCandidatePath: selected.path,
        expectedCandidateItemId: selected.itemId,
      });
      setOpen(false);
      setCandidates(null);
      setSelectedId(null);
      setConfirmRemove(false);
      props.onToast("ok", "缺失文件记录已重新定位");
      props.onChanged();
    } catch (e) {
      setError(describeError(e));
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async () => {
    setBusy(true);
    setError("");
    try {
      await removeMissingAsset(asset.id, { expectedItemId: asset.item_id, expectedPath: asset.path });
      setOpen(false);
      setCandidates(null);
      setSelectedId(null);
      setConfirmRemove(false);
      props.onToast("ok", "缺失文件记录已移除");
      props.onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = candidates?.find((candidate) => candidate.assetId === selectedId) ?? null;

  return (
    <div className="missing-asset-actions">
      <div className="row wrap" style={{ gap: "5px" }}>
        <button className="btn tiny" disabled={busy || loading} onClick={() => void findCandidates()}>
          {loading ? "正在查找…" : "重新定位"}
        </button>
        <button className="btn tiny danger" disabled={busy} onClick={askToRemove}>
          移除缺失记录
        </button>
        {asset.sha256_state !== "ok" || !asset.sha256 ? <span className="hint">此记录没有可用 SHA-256，可能无法找到匹配文件。</span> : null}
      </div>

      {open && (
        <div className="missing-asset-recovery">
          {error && <div className="err" role="alert">{error}</div>}
          {loading && <div className="hint" role="status">正在查找相同文件…</div>}
          {!loading && candidates && candidates.length === 0 && (
            <div className="hint" role="status">{reason || "没有找到可重新定位的文件。可以重试查找，或移除此缺失记录。"}</div>
          )}
          {!loading && candidates && candidates.length > 0 && (
            <>
              <div className="hint">选择一个匹配文件。将把这条缺失记录转到所选路径。</div>
              {candidates.map((candidate) => (
                <label className="missing-asset-candidate" key={candidate.assetId}>
                  <input type="radio" name={"missing-asset-" + asset.id} checked={selectedId === candidate.assetId}
                    disabled={busy} onChange={() => setSelectedId(candidate.assetId)} />
                  <span><b>{candidate.title}</b> <span className="hint">素材 #{candidate.itemId}</span><br />
                    <span className="mono missing-asset-path">{candidate.path}</span></span>
                </label>
              ))}
              {selected && <div className="missing-asset-confirm">
                {selected.itemId === asset.item_id
                  ? <div>这两条登记将合并为一条，保留新位置。</div>
                  : <div>该文件将从《{selected.title}》转到当前素材。两张卡片和其他文件都会保留。</div>}
                <div className="hint">旧位置：<span className="mono missing-asset-path">{asset.path}</span></div>
                <div className="hint">新位置：<span className="mono missing-asset-path">{selected.path}</span></div>
                <button className="btn tiny primary" disabled={busy} onClick={() => void doRelocate()}>{busy ? "核对文件内容中…" : "确认重新定位"}</button>
              </div>}
            </>
          )}
          {confirmRemove && <div className="missing-asset-confirm">
            <div>确认仅清除这条文件登记？磁盘文件、当前素材卡片和历史记录都会保留。</div>
            <div className="hint">待移除的登记路径：<span className="mono missing-asset-path">{asset.path}</span></div>
            <div className="row wrap">
              <button className="btn tiny danger" disabled={busy} onClick={() => void doRemove()}>{busy ? "正在移除…" : "确认移除缺失记录"}</button>
              <button className="btn tiny" disabled={busy} onClick={closeAction}>取消</button>
            </div>
          </div>}
          {!confirmRemove && <div className="row wrap" style={{ marginTop: "5px" }}>
            {(error || candidates?.length === 0) && <button className="btn tiny" disabled={busy || loading} onClick={() => void findCandidates()}>重试查找</button>}
            <button className="btn tiny" disabled={busy} onClick={closeAction}>关闭</button>
          </div>}
        </div>
      )}
    </div>
  );
}
