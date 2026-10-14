// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.4) — the per-person send limit: 30 sends per hour. It is a guard against a runaway client or
// script, not a quota. A sliding window of timestamps per person, in process memory (so it resets on restart and is per instance: a
// guard, not a ledger). It stores a person id and times only, never an address or a word of a message.
export const SENDS_PER_HOUR = 30;
export const WINDOW_MS = 60 * 60 * 1000;
/** Bound on the number of people tracked at once (a Map iterates in insertion order, so the oldest is dropped first). */
const MAX_TRACKED = 10_000;

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class SendRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = SENDS_PER_HOUR,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /** Counts one send for `person` at `now` when allowed. When the window is full, answers how long until the oldest send leaves it
   *  (at least one second) and counts nothing. */
  consume(person: string, now: number = Date.now()): RateDecision {
    const cutoff = now - this.windowMs;
    const live = (this.hits.get(person) ?? []).filter((t) => t > cutoff);
    if (live.length >= this.limit) {
      this.hits.set(person, live);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((live[0] + this.windowMs - now) / 1000)) };
    }
    live.push(now);
    // re-insert so a person who just sent is the newest entry when the map is trimmed
    this.hits.delete(person);
    this.hits.set(person, live);
    if (this.hits.size > MAX_TRACKED) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { ok: true };
  }

  /** Sends `person` has made inside the window (a test read). */
  used(person: string, now: number = Date.now()): number {
    return (this.hits.get(person) ?? []).filter((t) => t > now - this.windowMs).length;
  }

  reset(): void {
    this.hits.clear();
  }

  trackedPeople(): number {
    return this.hits.size;
  }
}
