/**
 * Unity 一键安装的 view/handler helper（T4；spec 2026-11-05-unity-mcp-install-design §7-§10）。
 *
 * 分层：本文件只依赖 types（不 import api.ts），api.ts 反过来复用这里的请求体构造，
 * 因此没有运行时循环。handler 工厂把状态读写/传输全部注入，便于真实执行断言（非 DOM）。
 *
 * 语义纪律：
 * - preview 只读工程；apply 才写 manifest；cancel 只失效预览、不回滚。
 * - config_applied ≠ UPM/编译/桥接就绪：成功文案只承诺「配置已写入」。
 * - replace 未勾选时按钮与 handler 双门；conflict 一律不可 apply。
 */
import type {
  UnityInstallApplyResult, UnityInstallChange, UnityInstallOperation, UnityInstallPreview,
  UnityInstallProbe, UnityInstallStatus,
} from "./types";

const CHANGE_LABEL: Record<UnityInstallChange, string> = {
  add: "新增", replace: "替换", none: "已安装", conflict: "冲突",
};

/** 目标依赖变化 → 中文标签。 */
export function installChangeLabel(change: UnityInstallChange): string {
  return CHANGE_LABEL[change];
}

const STEP_LABEL: Record<string, string> = {
  config: "配置", upm: "UPM 解析", compile: "编译", bridge: "桥接", tool: "工具", server: "服务",
};

/** 操作步骤 → 中文标签；未知步骤原样返回，不伪造成功。 */
export function installStepLabel(step: string): string {
  return STEP_LABEL[step] ?? step;
}

/** apply 门控：无预览/冲突/替换未确认都不可应用。 */
export function installCanApply(preview: UnityInstallPreview | null, replaceConfirmed: boolean): boolean {
  if (!preview) return false;
  const change = preview.package.change;
  if (change === "conflict") return false;
  if (change === "replace" && !replaceConfirmed) return false;
  return true;
}

/** apply 请求体：只含 previewId/confirm/confirmReplace（不接受客户端 projectPath/package）。 */
export function installApplyBody(previewId: string, confirmReplace: boolean): { previewId: string; confirm: true; confirmReplace: boolean } {
  return { previewId, confirm: true, confirmReplace };
}

export function installPreviewRequest(projectPath: string): { projectPath: string } {
  return { projectPath };
}

export function installStatusRequest(projectPath: string): { projectPath: string } {
  return { projectPath };
}

/** probe 只带 previewId 或 operationId（工程来自服务端已校验的预览/操作）。 */
export function installProbeRequest(input: { previewId?: string; operationId?: string }): { previewId?: string; operationId?: string } {
  return input.previewId !== undefined ? { previewId: input.previewId } : { operationId: input.operationId };
}

/** 回滚请求的**目标身份**（路径段）；wire body 按 spec §10 固定 {confirm:true}。 */
export function installRollbackRequest(operationId: string): { operationId: string } {
  return { operationId };
}

/** 取消预览请求的**目标身份**（路径段）；该端点无 body。 */
export function installCancelRequest(previewId: string): { previewId: string } {
  return { previewId };
}

export interface UnityInstallApi {
  preview: (projectPath: string) => Promise<UnityInstallPreview>;
  apply: (previewId: string, confirmReplace?: boolean) => Promise<UnityInstallApplyResult>;
  operation: (operationId: string) => Promise<UnityInstallOperation>;
  rollback: (operationId: string) => Promise<UnityInstallOperation>;
  cancelPreview: (previewId: string) => Promise<{ cancelled: boolean }>;
  status: (projectPath: string) => Promise<UnityInstallStatus>;
  probe: (input: { previewId?: string; operationId?: string }) => Promise<UnityInstallProbe>;
}

export interface UnityInstallHandlerDeps {
  api: UnityInstallApi;
  getProjectPath: () => string;
  getPreview: () => UnityInstallPreview | null;
  getReplaceConfirmed: () => boolean;
  getOperationId: () => string | null;
  setPreview: (p: UnityInstallPreview | null) => void;
  setOperation: (o: UnityInstallOperation | null) => void;
  setStatus: (s: UnityInstallStatus | null) => void;
  setProbe: (p: UnityInstallProbe | null) => void;
  setError: (e: string) => void;
  setBusy: (label: string) => void;
  onToast: (kind: "ok" | "bad" | "info", text: string) => void;
  describeError: (e: unknown) => string;
}

export interface UnityInstallHandlers {
  preview: () => Promise<void>;
  apply: () => Promise<void>;
  cancel: () => Promise<void>;
  status: () => Promise<void>;
  probe: () => Promise<void>;
  rollback: () => Promise<void>;
}

/** 真实 handler 工厂：SettingsPanel 只负责把 state 读写接进来。 */
export function createUnityInstallHandlers(deps: UnityInstallHandlerDeps): UnityInstallHandlers {
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    deps.setBusy(label);
    deps.setError("");
    try {
      await fn();
    } catch (e) {
      const message = deps.describeError(e);
      deps.setError(message);
      deps.onToast("bad", label + "失败：" + message);
    } finally {
      deps.setBusy("");
    }
  };

  const preview = () => run("预览", async () => {
    const path = deps.getProjectPath().trim();
    if (!path) { deps.onToast("bad", "先填 Unity 工程路径"); return; }
    const p = await deps.api.preview(path);
    deps.setPreview(p);
    deps.onToast("info", "预览已生成（未写入工程）：" + installChangeLabel(p.package.change));
  });

  const apply = () => run("应用", async () => {
    const p = deps.getPreview();
    if (!p) { deps.onToast("bad", "先生成预览"); return; }
    if (!installCanApply(p, deps.getReplaceConfirmed())) {
      deps.onToast("bad", p.package.change === "conflict"
        ? "该工程存在冲突，不能应用"
        : "替换同包不同版本前必须勾选确认");
      return;
    }
    const r = await deps.api.apply(p.previewId, deps.getReplaceConfirmed());
    // 预览已被消费：清掉，避免二次 apply 撞 PREVIEW_STALE；也让 probe 自然回落到 operationId。
    deps.setPreview(null);
    // 真实 operationId 必须回读成 operation 状态，否则 rollback 永远不可达（U10 I1）。
    // already_installed 时 operationId 为 null：不拉 operation、不伪造 id，并清掉上一 operation（U12 M7），
    // 否则 rollback 会指向已过期的旧 id。
    if (r.operationId) deps.setOperation(await deps.api.operation(r.operationId));
    else deps.setOperation(null);
    deps.onToast("ok", r.status === "already_installed"
      ? "已安装同版本，未写文件"
      : "配置已写入（UPM/编译/桥接未验证）");
  });

  const cancel = () => run("取消预览", async () => {
    const p = deps.getPreview();
    if (!p) { deps.onToast("bad", "没有可取消的预览"); return; }
    await deps.api.cancelPreview(p.previewId);
    deps.setPreview(null);
    deps.onToast("info", "已取消预览（未写工程，未回滚任何内容）");
  });

  const status = () => run("状态", async () => {
    const path = deps.getProjectPath().trim();
    if (!path) { deps.onToast("bad", "先填 Unity 工程路径"); return; }
    deps.setStatus(await deps.api.status(path));
  });

  const probe = () => run("探测", async () => {
    const p = deps.getPreview();
    const opId = deps.getOperationId();
    const input = p ? { previewId: p.previewId } : opId ? { operationId: opId } : null;
    if (!input) { deps.onToast("bad", "先生成预览或应用一次"); return; }
    deps.setProbe(await deps.api.probe(input));
  });

  const rollback = () => run("回滚", async () => {
    const opId = deps.getOperationId();
    if (!opId) { deps.onToast("bad", "没有可回滚的操作"); return; }
    deps.setOperation(await deps.api.rollback(opId));
  });

  return { preview, apply, cancel, status, probe, rollback };
}
