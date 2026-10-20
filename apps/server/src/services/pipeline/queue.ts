/**
 * 有界并发队列（v0.6.0）
 *
 * 用途：发现批次、缩略图等"内存中的短任务"，以及测试里验证并发/背压/取消语义。
 * 持久化阶段任务（hash/archive/…）以 index_tasks 表为准，不靠内存队列；但两者共用同一套语义：
 *   queued → running → done | failed | cancelled | skipped
 *
 * 关键保证：
 *  - 并发上限严格生效（pump 只在 running < concurrency 时启动）；
 *  - 水位（highWater）只表示"暂缓接收"，**不是失败**；push 返回 accepted=false，调用方等待 waitForSpace；
 *  - 同 key 去重：已有 queued/running 时复用，不重复执行；
 *  - 取消是幂等的：取消不存在/已完成的任务不报错；
 *  - drain() 在全部任务终态后 resolve，绝不无限等待（可给 timeout）。
 */
import { createHash } from "node:crypto";

export type QueueTaskState = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";
export type QueuePushResult = { accepted: true; key: string } | { accepted: false; reason: "high_water" | "paused" | "closed"; key: string };

export interface QueueTask<T = unknown> {
  /** 去重键：同一 key 在 queued/running 期间只执行一次 */
  key: string;
  priority?: number;
  run: (signal: AbortSignal) => Promise<T>;
}

export interface QueueStats {
  name: string;
  concurrency: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  skipped: number;
  peakDepth: number;
  highWater: number;
  paused: boolean;
  closed: boolean;
}

interface Entry {
  key: string;
  priority: number;
  seq: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
}

export class BoundedQueue {
  private pending: Entry[] = [];
  private running = new Set<string>();
  private seq = 0;
  private pausedFlag = false;
  private closedFlag = false;
  private counters = { done: 0, failed: 0, cancelled: 0, skipped: 0, peakDepth: 0 };
  private drainWaiters: Array<() => void> = [];
  private spaceWaiters: Array<() => void> = [];
  /** 运行中任务的 controller（取消需要能 abort 正在跑的那一个） */
  private controllers = new Map<string, AbortController>();

  constructor(
    readonly name: string,
    private readonly opts: { concurrency: number; highWater?: number; lowWater?: number },
  ) {
    this.opts.concurrency = Math.max(1, Math.floor(opts.concurrency));
    this.opts.highWater = Math.max(1, Math.floor(opts.highWater ?? 1000));
    this.opts.lowWater = Math.max(0, Math.floor(opts.lowWater ?? Math.floor((this.opts.highWater ?? 1000) / 4)));
  }

  get concurrency(): number { return this.opts.concurrency; }
  get depth(): number { return this.pending.length; }
  get active(): number { return this.running.size; }
  get paused(): boolean { return this.pausedFlag; }
  get closed(): boolean { return this.closedFlag; }
  get highWater(): number { return this.opts.highWater!; }

  /** 入队。highWater 满 / 暂停 / 关闭时返回 accepted=false（不是失败，调用方自己决定等待或丢弃）。 */
  push(task: QueueTask): QueuePushResult {
    if (this.closedFlag) return { accepted: false, reason: "closed", key: task.key };
    if (this.pausedFlag) return { accepted: false, reason: "paused", key: task.key };
    if (this.has(task.key)) return { accepted: true, key: task.key };
    if (this.pending.length + this.running.size >= this.highWater) return { accepted: false, reason: "high_water", key: task.key };
    this.pending.push({ key: task.key, priority: task.priority ?? 0, seq: ++this.seq, run: task.run, controller: new AbortController() });
    this.counters.peakDepth = Math.max(this.counters.peakDepth, this.pending.length);
    this.pump();
    return { accepted: true, key: task.key };
  }

  has(key: string): boolean {
    return this.running.has(key) || this.pending.some((e) => e.key === key);
  }

  /** 等到积压降到 lowWater 或以下（真正的迟滞；不是"低于 highWater 就放行"）。超时返回 false。 */
  async waitForSpace(timeoutMs = 30_000): Promise<boolean> {
    const low = this.opts.lowWater ?? 0;
    if (this.pending.length + this.running.size <= low) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => { const t = setTimeout(r, 50); t.unref?.(); });
      if (this.pending.length + this.running.size <= low) return true;
    }
    return false;
  }

  pause(): void { this.pausedFlag = true; }
  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    this.pump();
  }
  /** 关闭：不再接收新任务；已排队任务标 skipped（不执行），运行中的等其自行结束。 */
  close(): void {
    this.closedFlag = true;
    for (const e of this.pending) { e.controller.abort("closed"); this.counters.skipped++; }
    this.pending = [];
    this.maybeSettle();
  }

  /** 取消：排队中直接移除；运行中 abort（任务自己检查 signal）。幂等。 */
  cancel(key: string): boolean {
    const idx = this.pending.findIndex((e) => e.key === key);
    if (idx >= 0) {
      const [e] = this.pending.splice(idx, 1);
      this.counters.cancelled++;
      e!.controller.abort("cancelled");
      this.maybeSettle();
      return true;
    }
    const controller = this.controllers.get(key);
    if (controller) { controller.abort("cancelled"); return true; }
    return false;
  }

  async drain(timeoutMs = 0): Promise<boolean> {
    if (this.idle()) return true;
    const wait = new Promise<boolean>((resolve) => this.drainWaiters.push(() => resolve(true)));
    if (!timeoutMs) return await wait;
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
    const ok = await Promise.race([wait, timeout]);
    if (timer) clearTimeout(timer);
    return ok;
  }

  stats(): QueueStats {
    return {
      name: this.name,
      concurrency: this.concurrency,
      queued: this.pending.length,
      running: this.running.size,
      done: this.counters.done,
      failed: this.counters.failed,
      cancelled: this.counters.cancelled,
      skipped: this.counters.skipped,
      peakDepth: this.counters.peakDepth,
      highWater: this.highWater,
      paused: this.pausedFlag,
      closed: this.closedFlag,
    };
  }

  private idle(): boolean { return this.pending.length === 0 && this.running.size === 0; }

  private pump(): void {
    while (!this.pausedFlag && this.running.size < this.concurrency && this.pending.length > 0) {
      const i = this.pickIndex();
      const [entry] = this.pending.splice(i, 1);
      if (!entry) break;
      this.running.add(entry.key);
      this.controllers.set(entry.key, entry.controller);
      void this.execute(entry);
    }
  }

  /** 优先级高者先出；同优先级按入队顺序（稳定，避免大包被小文件无限插队）。 */
  private pickIndex(): number {
    let best = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const a = this.pending[i]!, b = this.pending[best]!;
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return best;
  }

  private async execute(entry: Entry): Promise<void> {
    try {
      await entry.run(entry.controller.signal);
      if (entry.controller.signal.aborted) this.counters.cancelled++;
      else this.counters.done++;
    } catch (e) {
      if (entry.controller.signal.aborted) this.counters.cancelled++;
      else {
        this.counters.failed++;
        // 失败原因由任务自己的持久化层记录；这里不吞掉，交调用方日志
        console.error("[queue:" + this.name + "] task " + entry.key + " failed: " + String((e as Error)?.message ?? e));
      }
    } finally {
      this.running.delete(entry.key);
      this.controllers.delete(entry.key);
      this.pump();
      this.maybeSettle();
    }
  }

  private maybeSettle(): void {
    if (this.pending.length + this.running.size < this.highWater) {
      const waiters = this.spaceWaiters.splice(0);
      for (const w of waiters) w();
    }
    if (this.idle()) {
      const waiters = this.drainWaiters.splice(0);
      for (const w of waiters) w();
    }
  }
}

/** 稳定短键：用于日志/诊断，不参与正确性判断。 */
export function shortKey(...parts: Array<string | number>): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
