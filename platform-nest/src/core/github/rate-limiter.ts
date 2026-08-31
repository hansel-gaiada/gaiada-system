// GH-02 §4.7 — the shared per-installation rate-limit bucket + per-user fairness queue.
//
// "One installation bucket for the entire company. One user's bulk operation starves everyone else.
// Requires a queue with per-user fairness and backoff — not naive retry."
//
// DESIGN: exactly one call is ever in flight per installation at a time (this class serializes
// dispatch), because the resource being protected — GitHub's per-installation rate limit — is shared
// no matter how many calls run concurrently; parallelizing would only race more callers for the same
// budget while making the x-ratelimit-* accounting racy to reason about. Fairness is round-robin
// ACROSS USERS, not FIFO across all queued work: each user gets one task drained per pass through the
// queue, then goes to the back of the line if they have more queued — so a bulk operation enqueuing
// 500 tasks for user A never delays user B's single task by more than one in-flight call.
//
// Two independent throttles compose here:
//   1. REACTIVE — a 403/429 (rate_limit or secondary_limit) with a Retry-After makes the WHOLE queue
//      pause for that duration (the bucket is shared, so nothing else can safely run either) before
//      redrivng the failed task, up to a bounded attempt count.
//   2. PROACTIVE — every response's x-ratelimit-remaining/-reset is observed even on SUCCESS
//      (`observe()`), so the queue can pre-emptively pause once the bucket hits zero rather than
//      waiting to be told no by a 429 it could have seen coming.
//
// This file is pure: no fetch, no GitHub-specific error classes (errors.ts is NOT imported here) —
// only `GithubRetryableSignal`, a queue-internal protocol between this file and http-client.ts. That
// keeps the fairness/backoff algorithm unit-testable with a fake clock and no network at all, and
// keeps http-client.ts (the one file allowed to make an outbound call, per the egress inventory) the
// single place that turns a retryable signal into a domain error for a caller that exhausted retries.
export class GithubRetryableSignal extends Error {
  constructor(
    readonly operation: string,
    /** Milliseconds to wait before the queue may try anything again (from Retry-After / rate-limit
     *  reset), never negative. */
    readonly retryAfterMs: number,
    readonly remaining: number,
  ) {
    super(`retryable github failure: ${operation} (retry after ${retryAfterMs}ms)`);
    this.name = "GithubRetryableSignal";
  }
}

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds, from x-ratelimit-reset (seconds) * 1000. */
  resetAtMs: number | null;
}

const EMPTY_SNAPSHOT: RateLimitSnapshot = { limit: null, remaining: null, resetAtMs: null };

export interface ScheduleOptions {
  /** Total attempts (including the first), bounding how many times a single retryable failure is
   *  redriven before the queue gives up and rejects with the (still-retryable) signal for the caller
   *  to map into a hard error. Default 4 — enough to absorb one genuine secondary-rate-limit window
   *  without letting a single stuck task monopolize the shared queue indefinitely. */
  maxAttempts?: number;
}

interface QueueEntry {
  userId: string;
  invoke: () => Promise<void>;
}

export class InstallationRateLimiter {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly order: string[] = [];
  private draining = false;
  private pauseUntilMs = 0;
  private snapshot: RateLimitSnapshot = EMPTY_SNAPSHOT;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Record the latest x-ratelimit-* headers, called after EVERY response (success or failure) by
   *  http-client.ts. Partial updates are fine — a response missing a header leaves that field as
   *  last observed rather than reverting to unknown. */
  observe(partial: Partial<RateLimitSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
  }

  rateLimitSnapshot(): RateLimitSnapshot {
    return this.snapshot;
  }

  /** Total queued (not-yet-started) tasks, optionally scoped to one user. Feeds the admin/info
   *  surface (§4.7 "surface remaining quota") so an operator can see a backlog forming. */
  queueDepth(userId?: string): number {
    if (userId !== undefined) return this.queues.get(userId)?.length ?? 0;
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  activeUserCount(): number {
    return this.order.length;
  }

  /** Schedule `run` under this installation's shared bucket, fairly interleaved with every other
   *  user's queued work. `run(attempt)` may throw `GithubRetryableSignal` to ask for a backoff+retry;
   *  any other thrown value (or a signal after `maxAttempts` is exhausted) rejects the returned
   *  promise with that value unchanged — this class never wraps or reinterprets a caller's error. */
  schedule<T>(userId: string, run: (attempt: number) => Promise<T>, opts: ScheduleOptions = {}): Promise<T> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    return new Promise<T>((resolve, reject) => {
      const attempt = (n: number): QueueEntry => ({
        userId,
        invoke: async () => {
          try {
            resolve(await run(n));
          } catch (e) {
            if (e instanceof GithubRetryableSignal) {
              this.pauseUntilMs = Math.max(this.pauseUntilMs, this.clock() + e.retryAfterMs);
              if (n + 1 < maxAttempts) {
                this.enqueue(attempt(n + 1));
                return;
              }
            }
            reject(e);
          }
        },
      });
      this.enqueue(attempt(0));
      // Deferred, deliberately: a caller building a BULK operation typically issues many
      // `schedule()` calls synchronously in one tick (e.g. `items.map(i => limiter.schedule(...))`)
      // — exactly the shape §4.7 is about. `drain()`'s body runs synchronously up to its own first
      // `await`, so calling it directly here would let it dequeue and start THIS task before the
      // rest of that same synchronous burst (or another user's call issued right after it) has had
      // a chance to enqueue — starving nobody in practice, but only by accident of timing, and
      // making the round-robin depend on how a caller happens to loop rather than on this class's
      // own guarantee. Deferring the kick to a microtask lets an entire synchronous burst land in
      // its queues first, so fairness is decided by what is ACTUALLY pending, not by scheduling
      // order within one tick. Real requests arriving from separate I/O events are unaffected — each
      // already yields to the microtask queue on its own account before this is ever called.
      queueMicrotask(() => void this.drain());
    });
  }

  private enqueue(entry: QueueEntry): void {
    let q = this.queues.get(entry.userId);
    const isNewUser = !q || q.length === 0;
    if (!q) {
      q = [];
      this.queues.set(entry.userId, q);
    }
    q.push(entry);
    if (isNewUser && !this.order.includes(entry.userId)) this.order.push(entry.userId);
  }

  private async waitOutPauses(): Promise<void> {
    for (;;) {
      const now = this.clock();
      if (this.pauseUntilMs > now) {
        await this.sleep(this.pauseUntilMs - now);
        continue;
      }
      // Proactive throttle: the last observed snapshot says the bucket is dry and hasn't reset yet.
      if (this.snapshot.remaining === 0 && this.snapshot.resetAtMs !== null && this.snapshot.resetAtMs > this.clock()) {
        await this.sleep(this.snapshot.resetAtMs - this.clock());
        continue;
      }
      return;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const userId = this.order.shift();
        if (userId === undefined) return;
        const q = this.queues.get(userId);
        const entry = q?.shift();
        if (!entry) {
          this.queues.delete(userId);
          continue;
        }
        if (q && q.length > 0) this.order.push(userId); // more from this user -> back of the line
        else this.queues.delete(userId);
        await this.waitOutPauses();
        await entry.invoke(); // never throws — resolves/rejects the outer promise or requeues itself
      }
    } finally {
      this.draining = false;
    }
  }
}
