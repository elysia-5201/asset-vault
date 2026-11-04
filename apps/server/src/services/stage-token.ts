/**
 * stage token 编解码（spec §6.4 / P2-4）。
 *
 * 形状：`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadSegment))`。
 * 载荷绑定：最终路径 p、下载根 r、源商品号 i、size s、mtime m、sha256 h、过期 e、nonce n、进程 epoch ep。
 * 客户端只能回传 token 字符串；服务端不接受任何客户端提供的 stagedPath。
 *
 * 错误子码（不新增 AppErrorCode，统一 details.code）：
 *  - STAGE_TOKEN_INVALID：格式/签名/epoch 失效（410）。
 *  - STAGE_TOKEN_EXPIRED：TTL 过期（410，由 commit 判定）。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../../../packages/core/src/contracts";

export interface StageTokenPayload {
  v: 1;
  /** 最终路径（服务端下载落盘后的真实路径）。 */
  p: string;
  /** 下载根（realpath 前缀边界）。 */
  r: string;
  /** 源商品号；null = 无商品号。 */
  i: string | null;
  /** 文件字节数。 */
  s: number;
  /** mtime ISO 字符串。 */
  m: string;
  /** sha256 十六进制。 */
  h: string;
  /** 过期时刻（epoch ms）。 */
  e: number;
  /** 一次性 nonce（回执主键）。 */
  n: string;
  /** 进程 epoch（每次启动变化）。 */
  ep: string;
}

export interface StageTokenCodec {
  issue(p: Omit<StageTokenPayload, "v" | "ep">): string;
  verify(token: string): StageTokenPayload;
}

const invalid = (message: string): AppError =>
  new AppError("CONFLICT", message, 410, { code: "STAGE_TOKEN_INVALID" });

function isPayload(v: unknown): v is StageTokenPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return p.v === 1
    && typeof p.p === "string" && p.p !== ""
    && typeof p.r === "string" && p.r !== ""
    && (p.i === null || typeof p.i === "string")
    && typeof p.s === "number" && Number.isFinite(p.s)
    && typeof p.m === "string" && p.m !== ""
    && typeof p.h === "string" && p.h !== ""
    && typeof p.e === "number" && Number.isFinite(p.e)
    && typeof p.n === "string" && p.n !== ""
    && typeof p.ep === "string" && p.ep !== "";
}

/**
 * 只解码、不验签：commit 必须先用 nonce 查回执（回执优先于签名/epoch/TTL/文件检查），
 * 因此需要一个不依赖密钥的载荷读取入口。伪造 token 只能拿到自己的 nonce；回执命中时
 * token_hash 不同 → 409，不会返回他人指针。
 */
export function decodeStageTokenPayload(token: string): StageTokenPayload | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2 || parts[0] === "") return null;
  try {
    const raw = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return isPayload(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function createStageTokenCodec(secret: Buffer, epoch: string): StageTokenCodec {
  if (!Buffer.isBuffer(secret) || secret.length === 0) throw new Error("stage token secret 不能为空");
  if (typeof epoch !== "string" || epoch === "") throw new Error("stage token epoch 不能为空");
  const sign = (segment: string): Buffer => createHmac("sha256", secret).update(segment, "utf8").digest();

  return {
    issue(p) {
      const payload: StageTokenPayload = { v: 1, ...p, ep: epoch };
      const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return segment + "." + sign(segment).toString("base64url");
    },
    verify(token) {
      const parts = String(token ?? "").split(".");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") throw invalid("stage token 格式非法");
      const expected = sign(parts[0]);
      const got = Buffer.from(parts[1], "base64url");
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw invalid("stage token 签名无效");
      const payload = decodeStageTokenPayload(token);
      if (!payload) throw invalid("stage token 载荷非法");
      if (payload.ep !== epoch) throw invalid("stage token 已随进程重启失效");
      return payload;
    },
  };
}
