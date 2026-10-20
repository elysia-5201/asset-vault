/**
 * 取消 / 超时原语（core-content 所有）
 *
 * 为什么单独一个文件：解析层有 5 个入口（hash / archive.list / archive.read / unitypackage / images），
 * 每个都要「可中断 + 明确截止时间」，且错误必须可判别。contracts.ts 是 lead 冻结文件，
 * AppErrorCode 联合里没有 CANCELLED / TIMEOUT —— 这里集中做一次只放宽 code 的类型断言：
 * 运行时仍然是 AppError（instanceof / status 一致），调用方用 err.code === "CANCELLED" 判别即可。
 *
 * 协作纪律：
 *   - 只有「传了 opts.signal / opts.timeoutMs」才创建 Deadline（不传零开销，旧调用行为不变）
 *   - 检查点是协作式的：循环每轮 / 每次 await 前调用 deadline.check()
 *   - 不可中断的原生调用（sharp、unrar wasm）用 deadline.race()，超时/取消后立刻向上抛，
 *     底层工作仍在后台跑完（已 catch 掉，不会变 unhandled rejection）——这一点必须让调用方知道。
 */
import { AppError, type AppErrorCode } from "./contracts";

/** 运行时错误码（contracts 的联合未收录，故此处断言；见文件头说明）。 */
export const CANCELLED = "CANCELLED" as AppErrorCode;
export const TIMEOUT = "TIMEOUT" as AppErrorCode;

/** 调用方主动取消（AbortSignal）。status 409：请求与当前状态冲突，可重试/忽略。 */
export class CancelledError extends AppError {
  constructor(message = "cancelled") {
    super(CANCELLED, message, 409);
    this.name = "CancelledError";
  }
}

/** 超过调用方给定/内置的截止时间。status 408。 */
export class TimeoutError extends AppError {
  constructor(message = "timed out") {
    super(TIMEOUT, message, 408);
    this.name = "TimeoutError";
  }
}

export function isCancelledError(err: unknown): boolean {
  return err instanceof AppError && err.code === CANCELLED;
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof AppError && err.code === TIMEOUT;
}

export interface AbortOptions {
  /** 中止信号（调用方 AbortController）。 */
  signal?: AbortSignal;
  /** 整体截止时间（毫秒，从调用开始算）。 */
  timeoutMs?: number;
}

/**
 * 一次调用的截止状态。协作式：check() 主动抛，onStop() 用于杀子进程。
 * 时间判定以 Date.now() 为准（不依赖定时器是否被事件循环拖延），定时器只负责唤醒 race()。
 */
export class Deadline {
  readonly what: string;
  private readonly endAt: number | null;
  private readonly signal: AbortSignal | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private signalAborted = false;
  private timerFired = false;
  private readonly listeners = new Set<() => void>();
  private detachSignal: (() => void) | null = null;

  constructor(opts: AbortOptions, what: string) {
    this.what = what;
    const ms = opts.timeoutMs;
    this.endAt = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Date.now() + ms : null;
    this.signal = opts.signal ?? null;
    if (this.signal) {
      if (this.signal.aborted) this.signalAborted = true;
      const onAbort = () => { this.signalAborted = true; this.fire(); };
      this.signal.addEventListener("abort", onAbort, { once: true });
      this.detachSignal = () => { try { this.signal?.removeEventListener("abort", onAbort); } catch { /* ignore */ } };
    }
    if (this.endAt !== null) {
      const msLeft = Math.max(0, this.endAt - Date.now());
      this.timer = setTimeout(() => { this.timerFired = true; this.fire(); }, msLeft);
      // 不要因为一个截止定时器把进程钉住（后台索引流水线常见场景）
      this.timer.unref?.();
    }
  }

  /** 是否设置了任一限制（没有则检查点全是 no-op）。 */
  get limited(): boolean {
    return this.endAt !== null || this.signal !== null;
  }

  /** 是否已经触发（取消或超时）。 */
  get stopped(): boolean {
    return this.errorNow() !== null;
  }

  /** 剩余的毫秒数；没设 deadline 时返回 null（负数归零）。 */
  remainingMs(): number | null {
    if (this.endAt === null) return null;
    return Math.max(0, this.endAt - Date.now());
  }

  /** 判定当前应抛的错误（null = 正常继续）。 */
  errorNow(): AppError | null {
    if (this.signalAborted) return new CancelledError(`cancelled: ${this.what}`);
    if (this.timerFired || (this.endAt !== null && Date.now() >= this.endAt)) {
      return new TimeoutError(`timed out: ${this.what}`);
    }
    return null;
  }

  /** 检查点：每轮循环 / 每次 await 前调用。 */
  check(): void {
    const err = this.errorNow();
    if (err) throw err;
  }

  /** 注册「已取消/已超时」回调（用于 kill 7za 等子进程）；返回卸载函数。 */
  onStop(fn: () => void): () => void {
    if (this.stopped) { try { fn(); } catch { /* ignore */ } return () => { /* already */ }; }
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * 给不可中断的 Promise 套截止：超时/取消立刻抛，底层 Promise 继续跑（结果丢弃）。
   * 注意：调用方必须能接受「后台仍在解码」——sharp 就属于这一类。
   */
  race<T>(p: Promise<T>): Promise<T> {
    if (!this.limited) return p;
    const err = this.errorNow();
    if (err) { p.catch(() => { /* 丢弃 */ }); throw err; }
    let off: () => void = () => { /* noop */ };
    const guard = new Promise<never>((_, reject) => {
      off = this.onStop(() => reject(this.errorNow() ?? new CancelledError(`cancelled: ${this.what}`)));
    });
    p.catch(() => { /* 超时后底层继续跑：吞掉，避免 unhandled rejection */ });
    return Promise.race([p, guard]).finally(() => { off(); });
  }

  private fire(): void {
    for (const fn of Array.from(this.listeners)) {
      try { fn(); } catch { /* 单个订阅者失败不影响其他 */ }
    }
  }

  /** 释放定时器与 signal 监听（每次入口 finally 里调用）。 */
  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.detachSignal) { this.detachSignal(); this.detachSignal = null; }
    this.listeners.clear();
  }
}

/** 没传任何限制时返回 null（零开销路径）。 */
export function deadlineOf(opts: AbortOptions | undefined, what: string): Deadline | null {
  if (!opts) return null;
  if (opts.signal === undefined && opts.timeoutMs === undefined) return null;
  return new Deadline(opts, what);
}
