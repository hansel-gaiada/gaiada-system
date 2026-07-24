// Bounded in-process FIFO goal queue (B1, design §3.2). AGENT_MAX_CONCURRENT_GOALS workers drain a
// waiting list capped at AGENT_MAX_QUEUE; a full queue makes enqueue return false → the service answers
// 429. Purely promise-driven (no timer to unref) — nothing keeps the event loop alive on its own.
// Durable/resumable queueing is Temporal target-state (design §6); v1 is in-process + a boot sweep.

export type GoalWorker = (goalId: string) => Promise<void>;

export interface QueueSize {
  running: number;
  queued: number;
}

export class GoalQueue {
  private waiting: string[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private worker: GoalWorker,
    private opts: { maxConcurrent: number; maxQueue: number },
  ) {}

  /** Enqueue a goal id. Returns false (→ 429) when the waiting list is already at capacity. */
  enqueue(goalId: string): boolean {
    if (this.waiting.length >= this.opts.maxQueue) return false;
    this.waiting.push(goalId);
    this.pump();
    return true;
  }

  size(): QueueSize {
    return { running: this.running, queued: this.waiting.length };
  }

  /** Resolves when no goal is running or waiting (test/shutdown aid). */
  idle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.opts.maxConcurrent && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      this.running++;
      // Errors inside a worker must never crash the loop — each goal's failure is already persisted as a
      // typed status by the worker itself; the queue only guarantees liveness.
      void this.worker(id)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.pump();
          this.checkIdle();
        });
    }
    this.checkIdle();
  }

  private checkIdle(): void {
    if (this.running === 0 && this.waiting.length === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
