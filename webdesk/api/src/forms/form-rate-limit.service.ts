// WSK-10 — per-IP AND per-form rate limiting (§11 AC, both mandatory, both independently
// enforced). Redis-backed (INCR + PEXPIRE fixed window), unlike rate-limit/tenant-quota.service.ts
// (WSK-05's in-memory per-process counter) — this endpoint is UNAUTHENTICATED and internet-facing,
// so it is exactly the "noisy neighbour"/abuse case an in-memory single-process counter under-
// enforces the moment there is more than one api replica; Redis is already a hard dependency of
// this project (BullMQ) so there is no new infrastructure cost to using it correctly here from the
// start.
//
// FAIL CLOSED on a Redis error (same doctrine as media/clamav.service.ts's header: a limiter that
// cannot be reached must refuse the request it cannot rate-limit, never silently let it through —
// the alternative turns "Redis had a blip" into "the abuse battery's own rate limit stopped
// working").
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { redisConnectionOptions } from "../queue/redis-connection";

export type RateLimitDecision = { allowed: boolean; remaining: number; limit: number };

@Injectable()
export class FormRateLimitService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    // `maxRetriesPerRequest: null` (redisConnectionOptions()'s own value) is a BullMQ-Worker-only
    // requirement (blocking commands) that does not apply here and would make an unreachable Redis
    // hang this request forever instead of failing closed promptly — overridden explicitly.
    this.redis = new Redis({ ...redisConnectionOptions(), maxRetriesPerRequest: 3, lazyConnect: false });
  }

  /** One fixed window, keyed by `scope:key:windowStart`. Throws on any Redis-level failure —
   *  callers (form-rate-limit.guard.ts) must treat a throw as "refuse the request", never as
   *  "allow it". */
  async consume(scope: "ip" | "form", key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const redisKey = `webdesk:forms:rl:${scope}:${key}:${windowStart}`;

    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      // Only the FIRST request in a window sets the expiry — every subsequent INCR in the same
      // window must not reset it (that would let a fast-enough attacker keep the key alive
      // forever by re-triggering PEXPIRE on every request).
      await this.redis.pexpire(redisKey, windowMs);
    }

    return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {
      /* already down — nothing more to do */
    });
  }
}
