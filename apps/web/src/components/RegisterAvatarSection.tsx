/**
 * 「设为模型本体」表单（SALT 首次确认；契约 /root/Code/.asset-vault-followup-20261105/salt-approval-and-contract.md）。
 *
 * 语义边界：
 * - 只有用户点「确认登记」才 POST；点开/取消/改输入都不建档（不自动、不猜名称）。
 * - 新建与复用是两个互斥请求体：复用只带 existingAvatarId，绝不混传 name/aliases，也不用 force。
 * - 409 冲突（同名/别名）先展示已有模型，由用户再点一次「复用这个已有模型」才复用；不静默合并、不改名。
 * - 「标记已拥有」默认勾选；取消勾选只表示本次不标记，不撤销已有 owned=1（服务端保证）。
 * - 成功后回调父刷新详情/avatars/items；列表仍走既有 GET，不把创建返回塞进列表。
 */
import { useState } from "react";
import { avatarConflictOf, describeError, registerAvatar, type AvatarConflict } from "../api";
import { Spinner } from "./ui";

export function RegisterAvatarSection(props: {
  itemId: number;
  onRegistered: (r: { avatarId: number; created: boolean }) => void;
  onToast?: (kind: "ok" | "bad" | "info", text: string) => void;
}) {
  const { itemId, onRegistered, onToast } = props;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const [owned, setOwned] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<AvatarConflict | null>(null);

  /** 只切换展开态：不 POST、不建档。 */
  const toggleOpen = () => {
    setOpen((v) => !v);
    setError("");
  };

  /** 取消：关闭并清掉冲突/错误，不 POST。 */
  const cancel = () => {
    setOpen(false);
    setConflict(null);
    setError("");
  };

  const confirmRegister = () => {
    const trimmed = name.trim();
    if (trimmed === "") { setError("模型名不能为空"); return; }
    const aliases = aliasesText.split(/[,、\n]/).map((s) => s.trim()).filter((s) => s !== "");
    setBusy(true); setError(""); setConflict(null);
    return registerAvatar(itemId, { name: trimmed, aliases, owned })
      .then((r) => {
        onToast?.("ok", r.created ? "已建档并关联：" + trimmed : "已复用模型 #" + r.avatarId);
        onRegistered(r);
        setOpen(false); setName(""); setAliasesText(""); setOwned(true);
      })
      .catch((e) => {
        const c = avatarConflictOf(e);
        if (c) { setConflict(c); return; }
        setError(describeError(e));
      })
      .finally(() => setBusy(false));
  };

  /** 用户在看到已有模型后再次确认：只带 existingAvatarId。 */
  const confirmReuse = () => {
    if (!conflict) return;
    setBusy(true); setError("");
    return registerAvatar(itemId, { existingAvatarId: conflict.avatarId, owned })
      .then((r) => {
        onToast?.("ok", "已复用模型 #" + r.avatarId + "（" + conflict.avatarName + "）");
        onRegistered(r);
        setOpen(false); setConflict(null); setName(""); setAliasesText(""); setOwned(true);
      })
      .catch((e) => setError(describeError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ marginTop: "7px" }}>
      <button
        className="btn tiny"
        onClick={toggleOpen}
        title="把当前条目登记为一个模型本体：首次确认名称/别名/已拥有，不自动建档"
      >{open ? "收起登记表单" : "设为模型本体…"}</button>
      {open && (
        <div style={{ marginTop: "5px", borderTop: "1px solid var(--line-soft)", paddingTop: "5px" }}>
          <div className="row wrap" style={{ gap: "6px" }}>
            <input value={name} placeholder="模型名（必填）" onChange={(e) => setName(e.target.value)} />
            <input value={aliasesText} placeholder="别名（逗号/顿号分隔，可空）" onChange={(e) => setAliasesText(e.target.value)} />
          </div>
          <label className="chk" style={{ marginTop: "4px" }} title="只标记为已拥有；取消勾选不会撤销已有 owned=1">
            <input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} />
            标记已拥有
          </label>
          <div className="row wrap" style={{ gap: "6px", marginTop: "4px" }}>
            <button className="btn tiny" disabled={busy} onClick={confirmRegister}>{busy ? <Spinner /> : "确认登记"}</button>
            <button className="btn tiny ghost" disabled={busy} onClick={cancel}>取消</button>
          </div>
          {error && <div className="hint" style={{ color: "var(--bad)" }}>{error}</div>}
          {conflict && (
            <div className="hint" style={{ color: "var(--warn)", marginTop: "4px" }}>
              已存在模型「{conflict.avatarName}」（#{conflict.avatarId}）：
              {conflict.code === "AVATAR_NAME_CONFLICT" ? "同名" : "别名冲突"}。不会自动合并或改名。
              <button className="btn tiny" disabled={busy} onClick={confirmReuse} style={{ marginLeft: "6px" }}>
                复用这个已有模型（#{conflict.avatarId}）
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
