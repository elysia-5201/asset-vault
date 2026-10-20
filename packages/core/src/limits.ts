/**
 * 限制码与「降级而非失败」的语义（core-content 所有）
 *
 * 契约（v0.6.0，lead 冻结）：解析入口超限时不抛异常让调用方猜，而是返回
 *   limited: { code, message } | null
 * 让流水线把「超限」记成可重跑的降级（调大限制后重跑），而不是错误。
 * 真正需要 Buffer 的 read 入口没有降级余地 —— 那里抛 LimitError（code 同为 BYTES/PIXELS），
 * 调用方按 code 分支（流水线 stages.ts 就是这么判的）。
 *
 * 注意：BYTES / ENTRIES / RATIO / PIXELS / CANCELLED / TIMEOUT 不在 contracts.ts 的
 * AppErrorCode 联合里（那是 lead 冻结文件），因此这里做一次集中的类型断言；
 * 运行时仍是 AppError（instanceof / status 一致），err.code === "BYTES" 可直接判别。
 */
import { AppError, type AppErrorCode } from "./contracts";

/** 列表/解析被限制的原因码。 */
export type LimitCode = "ENTRIES" | "BYTES" | "RATIO" | "TIMEOUT" | "CANCELLED" | "PIXELS";

export interface ListingLimit { code: LimitCode; message: string }

/** 运行时错误码（断言成 AppErrorCode，见文件头）。 */
export const LIMIT_BYTES = "BYTES" as AppErrorCode;
export const LIMIT_ENTRIES = "ENTRIES" as AppErrorCode;
export const LIMIT_RATIO = "RATIO" as AppErrorCode;
export const LIMIT_PIXELS = "PIXELS" as AppErrorCode;

/**
 * 硬上限错误：无法降级（调用方要求返回 Buffer / 缩略图）时抛。
 * status 400：请求本身触犯了声明的上限；不是服务端故障，也不该重试同样参数。
 */
export class LimitError extends AppError {
  readonly limitCode: LimitCode;
  constructor(limitCode: LimitCode, message: string) {
    const code =
      limitCode === "BYTES" ? LIMIT_BYTES
        : limitCode === "ENTRIES" ? LIMIT_ENTRIES
          : limitCode === "RATIO" ? LIMIT_RATIO
            : limitCode === "PIXELS" ? LIMIT_PIXELS
              : ("INVALID_INPUT" as AppErrorCode);
    super(code, message, 400);
    this.name = "LimitError";
    this.limitCode = limitCode;
  }
}

export function isLimitError(err: unknown): boolean {
  return err instanceof AppError && ["BYTES", "ENTRIES", "RATIO", "PIXELS"].includes(String(err.code));
}

/** 上限参数校验：负数/NaN 一律 INVALID_INPUT（调用方 bug，不静默夹紧）。 */
export function normalizeLimit(name: string, value: number | undefined | null, min = 0): number | null {
  if (value === undefined || value === null) return null;
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < min) {
    throw new AppError("INVALID_INPUT", `${name} must be a finite number >= ${min} (got ${value})`, 400);
  }
  return n;
}
