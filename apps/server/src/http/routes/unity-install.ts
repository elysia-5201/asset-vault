/**
 * Unity 安装 HTTP 路由（unity-install spec §6/§7/§8/§9）。
 *
 * 独立注册模块：只注册本 feature 的 7 个端点，不改总 routes.ts 业务。
 * 安全门：实际 socket peer + Host 双门（不信任 forwarded / request.ip / 仅 Host）；
 * apply 拒绝客户端 projectPath/package；op/previewId 必须是 UUID。
 */
import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import {
  applyPreview, cancelPreview, createPreview, getOperation, rollbackOperation,
  type UnityInstallDeps,
} from "../../services/unity-install";
import { probeInstall, statusInstall } from "../../services/unity-install-probe";
import { unityClientFor, type UnityMcp } from "../../services/unity";
import { isLoopbackListenHost } from "../../listen-host";
import { fail } from "../routes";

export interface UnityInstallRouteDeps {
  repo: Repo;
  dataDir: string;
  log: (m: string) => void;
  unityClient?: () => UnityMcp;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new AppError("INVALID_INPUT", label + " 必须是 UUID", 400, { code: "UNITY_INSTALL_INVALID_ID" });
  }
  return raw;
}

function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  if (a.startsWith("::ffff:")) return isLoopbackAddr(a.slice(7));
  return /^127\./.test(a);
}

/**
 * 解析 Host authority：只接受 host[:port] 或 [ipv6][:port]；
 * 端口必须是 1..65535 的纯数字；括号后只允许空或 ":port"（拒绝后缀垃圾）。
 */
function parseAuthority(raw: string): { host: string; port: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0) return null;
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    if (rest === "") return { host, port: null };
    if (!/^:\d{1,5}$/.test(rest)) return null;
    const port = rest.slice(1);
    return Number(port) <= 65535 ? { host, port } : null;
  }
  const colons = (s.match(/:/g) ?? []).length;
  if (colons === 0) return { host: s, port: null };
  if (colons === 1) {
    const i = s.indexOf(":");
    const host = s.slice(0, i);
    const port = s.slice(i + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return null;
    return { host, port };
  }
  return { host: s, port: null }; // 裸 IPv6（无端口）
}

/** Host 必须是完整 authority 的字面回环（复用 listen-host 的精确集合，不做前缀匹配）。 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const parsed = parseAuthority(host);
  if (!parsed) return false;
  return isLoopbackListenHost(parsed.host);
}

/** 实际 socket peer + Host 双门；不读 forwarded / request.ip。 */
function assertLoopback(req: { raw?: { socket?: { remoteAddress?: string } }; headers?: Record<string, unknown> }): void {
  const peer = req.raw?.socket?.remoteAddress;
  const host = typeof req.headers?.host === "string" ? req.headers.host : undefined;
  if (!isLoopbackAddr(peer) || !isLoopbackHost(host)) {
    throw new AppError("INVALID_INPUT", "只允许本机回环访问", 400, { code: "UNITY_INSTALL_LOOPBACK_ONLY" });
  }
}

export function registerUnityInstallRoutes(app: FastifyInstance, deps: UnityInstallRouteDeps): void {
  const installDeps: UnityInstallDeps = {
    dataDir: deps.dataDir,
    repo: deps.repo,
    log: deps.log,
    unityClient: deps.unityClient ?? (() => unityClientFor(deps.repo)),
  };

  app.post("/api/unity/install/preview", async (req, reply) => {
    try {
      assertLoopback(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const projectPath = typeof b.projectPath === "string" ? b.projectPath : "";
      if (!projectPath) throw new AppError("INVALID_INPUT", "projectPath 必填", 400, { code: "UNITY_INSTALL_PROJECT_INVALID" });
      return await createPreview(installDeps, projectPath);
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/unity/install/apply", async (req, reply) => {
    try {
      assertLoopback(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if ("projectPath" in b || "package" in b) {
        throw new AppError("INVALID_INPUT", "apply 不接受客户端 projectPath/package", 400, { code: "UNITY_INSTALL_CLIENT_PATH_FORBIDDEN" });
      }
      if (b.confirm !== true) throw new AppError("INVALID_INPUT", "confirm 必须为 true", 400, { code: "UNITY_INSTALL_CONFIRM_REQUIRED" });
      const previewId = requireUuid(b.previewId, "previewId");
      return await applyPreview(installDeps, { previewId, confirm: true, confirmReplace: b.confirmReplace === true });
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/unity/install/probe", async (req, reply) => {
    try {
      assertLoopback(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const input: { previewId?: string; operationId?: string } = {};
      if (typeof b.previewId === "string") input.previewId = requireUuid(b.previewId, "previewId");
      if (typeof b.operationId === "string") input.operationId = requireUuid(b.operationId, "operationId");
      if (!input.previewId && !input.operationId) {
        throw new AppError("INVALID_INPUT", "需要 previewId 或 operationId", 400, { code: "UNITY_INSTALL_INVALID_ID" });
      }
      return await probeInstall(installDeps, input);
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/unity/install/operations/:id", async (req, reply) => {
    try {
      assertLoopback(req);
      const id = requireUuid((req.params as { id?: unknown }).id, "operationId");
      return getOperation(installDeps, id);
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/unity/install/operations/:id/rollback", async (req, reply) => {
    try {
      assertLoopback(req);
      const id = requireUuid((req.params as { id?: unknown }).id, "operationId");
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.confirm !== true) throw new AppError("INVALID_INPUT", "rollback 需要 confirm:true", 400, { code: "UNITY_INSTALL_CONFIRM_REQUIRED" });
      return rollbackOperation(installDeps, id);
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/unity/install/previews/:previewId/cancel", async (req, reply) => {
    try {
      assertLoopback(req);
      const id = requireUuid((req.params as { previewId?: unknown }).previewId, "previewId");
      return cancelPreview(installDeps, id);
    } catch (e) { return fail(reply, e); }
  });

  app.get("/api/unity/install/status", async (req, reply) => {
    try {
      assertLoopback(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const projectPath = typeof q.projectPath === "string" ? q.projectPath : "";
      if (!projectPath) throw new AppError("INVALID_INPUT", "projectPath 必填", 400, { code: "UNITY_INSTALL_PROJECT_INVALID" });
      return statusInstall(installDeps, projectPath);
    } catch (e) { return fail(reply, e); }
  });
}
