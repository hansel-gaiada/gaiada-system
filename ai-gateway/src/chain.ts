// Capability chain: first configured+available+healthy provider wins; failures open a
// circuit breaker so a dying provider is skipped instead of retried on every call.
import { config } from "./config";
import type { Provider } from "./providers";

interface BreakerState {
  consecutiveFails: number;
  openUntil: number;
}

export class Chain {
  private breakers = new Map<string, BreakerState>();

  constructor(
    private providers: Provider[],
    private now: () => number = Date.now,
  ) {}

  private healthy(p: Provider): boolean {
    const b = this.breakers.get(p.name);
    return !b || b.openUntil <= this.now();
  }

  private recordFailure(p: Provider): void {
    const b = this.breakers.get(p.name) ?? { consecutiveFails: 0, openUntil: 0 };
    b.consecutiveFails++;
    if (b.consecutiveFails >= config.breakerThreshold) {
      b.openUntil = this.now() + config.breakerCooldownMs;
      b.consecutiveFails = 0;
    }
    this.breakers.set(p.name, b);
  }

  private recordSuccess(p: Provider): void {
    this.breakers.delete(p.name);
  }

  state(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.providers) {
      out[p.name] = !p.available() ? "unconfigured" : this.healthy(p) ? "ok" : "open";
    }
    return out;
  }

  /** Run `fn` against the first healthy provider; fail over on error. */
  async run<T>(fn: (p: Provider) => Promise<T>): Promise<{ result: T; provider: string }> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if (!p.available() || !this.healthy(p)) continue;
      try {
        const result = await fn(p);
        this.recordSuccess(p);
        return { result, provider: p.name };
      } catch (err) {
        this.recordFailure(p);
        errors.push(`${p.name}: ${(err as Error).message}`);
      }
    }
    throw new Error(`all providers failed — ${errors.join("; ") || "none available"}`);
  }
}
