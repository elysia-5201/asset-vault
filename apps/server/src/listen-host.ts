/**
 * C 项：AssetVault 是**本机工具**（没有账号/token 体系），所以 HTTP 监听默认只允许回环地址。
 *
 * 为什么不是"加个 token"：本轮批准的是有界可靠性修复，不新增鉴权系统；正确的最小动作是把
 * 已经默认回环的行为固化成**显式闸门**——HOST 环境变量写错（0.0.0.0 / 局域网 IP）时启动即失败，
 * 而不是悄悄把无鉴权的 API 暴露到局域网。确需对外时显式 ASSETVAULT_ALLOW_REMOTE_LISTEN=1，
 * 由使用者自己承担反向代理/鉴权。
 */

/** 回环监听地址（含 IPv6 方括号写法）。localhost 由 Node 解析，行为与 127.0.0.1 等价。 */
const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackListenHost(host: string): boolean {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_LISTEN_HOSTS.has(h);
}

/** 启动闸门：非回环且未显式放行 → 抛错（启动失败，不监听）。 */
export function assertLocalListenHost(host: string, opts: { allowRemote?: boolean } = {}): string {
  const h = String(host ?? "").trim() || "127.0.0.1";
  if (isLoopbackListenHost(h) || opts.allowRemote === true) return h;
  throw new Error(
    "拒绝监听非回环地址 " + h + "：AssetVault 是本机工具，HTTP 接口没有账号/token 鉴权。"
    + "确需对外监听请显式设置 ASSETVAULT_ALLOW_REMOTE_LISTEN=1，并自行在反向代理层做鉴权/隔离。",
  );
}
