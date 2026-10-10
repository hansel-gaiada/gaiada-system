// WSK-05 amendment (2026-08-26 reassessment §04: "Per-tenant read quotas / noisy-neighbour
// limits — rate limiting is specified for forms only, not content reads"). Fixed-window counter,
// keyed by TENANT (not by api key — a tenant rotating through several keys must not multiply its
// own quota), so one tenant hammering content reads cannot starve every other tenant sharing the
// same box (§11a).
//
// M3 T6: the counter lives in REDIS so the quota holds with more than one api replica. The window
// is ALIGNED (windowStart = floor(now / windowMs) * windowMs), so every replica derives the same key
// `webdesk:quota:<tenantId>:<windowStart>` for the same window. One Lua script does INCR and, only
// when the reply is 1 (the first hit of the window), PEXPIRE windowMs + a 1 s margin. Redis runs a
// script as one uninterruptible unit, so the count and the expiry are a single atomic round trip:
// no replica can observe the key without a TTL, and a later hit never re-extends it. An over-limit
// request still increments (harmless; the key dies with its window).
//
// REDIS DOWN => FAIL OPEN, ON PURPOSE (the opposite of forms/form-rate-limit.service.ts, which is
// unauthenticated and fails closed). If Redis errors or does not answer within 200 ms, this request
// is counted in the old per-process window instead. Availability of the public read path beats quota
// precision, and the per-process window still bounds each single replica. It never throws and never
// fails a read; the warning is logged at most once a minute.
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { config } from "../config";
import { redisConnectionOptions } from "../queue/redis-connection";

export type QuotaDecision = { allowed: boolean; remaining: number; resetAt: number; limit: number };

type Bucket = { windowStart: number; count: number };

export const QUOTA_KEY_PREFIX = "webdesk:quota:";
/** TTL = window + this, so a key never outlives its window by more than the margin. */
export const QUOTA_TTL_MARGIN_MS = 1_000;
const REDIS_TIMEOUT_MS = 200;
const WARN_EVERY_MS = 60_000;

const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`;

@Injectable()
export class TenantQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantQuotaService.name);
  private readonly buckets = new Map<string, Bucket>(); // per-process fallback only
  private redis?: Redis;
  private redisUrlOverride?: string;
  private lastWarnAt = 0;
  // Plain instance fields, not constructor params: a DI-managed class with a primitive-typed
  // constructor parameter (no explicit @Inject token) makes Nest try to resolve a provider for
  // `Number`, which does not exist, and boot fails. Reading config directly here avoids that.
  private limit = config.readQuotaPerMinute;
  private windowMs = config.readQuotaWindowMs;

  /**
   * Test-only override (also a legitimate future admin/per-tier hook, not just a test seam) —
   * never called from any request-handling path. Lets a single spec file exercise the 429 branch
   * deterministically without depending on process-wide env vars other test files might also be
   * touching.
   */
  withLimits(limit: number, windowMs: number): void {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets.clear();
  }

  /** Test-only: point this instance at another Redis (e.g. an unreachable one). Drops the old client. */
  useRedisUrl(url: string): void {
    this.redisUrlOverride = url;
    this.redis?.disconnect();
    this.redis = undefined;
  }

  private client(): Redis {
    if (!this.redis) {
      const base = redisConnectionOptions();
      let opts: typeof base = base;
      if (this.redisUrlOverride) {
        const u = new URL(this.redisUrlOverride);
        opts = { ...base, host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined };
      }
      // maxRetriesPerRequest: null (BullMQ-Worker only) would hang a command on a dead Redis.
      this.redis = new Redis({
        ...opts,
        maxRetriesPerRequest: 1,
        commandTimeout: REDIS_TIMEOUT_MS,
        connectTimeout: REDIS_TIMEOUT_MS,
        lazyConnect: true,
      });
      // ioredis emits 'error' on every failed reconnect; unhandled it would crash/spam the process.
      this.redis.on("error", () => undefined);
    }
    return this.redis;
  }

  /** Never throws. Redis answers within 200 ms or this request falls back to the process window. */
  async consume(tenantId: string, now = Date.now()): Promise<QuotaDecision> {
    const limit = this.limit;
    const windowMs = this.windowMs;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const resetAt = windowStart + windowMs;
    try {
      const count = await this.redisIncr(this.key(tenantId, windowStart), windowMs + QUOTA_TTL_MARGIN_MS);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt, limit };
    } catch (err) {
      this.warnOnce(err);
      return this.consumeLocal(tenantId, now);
    }
  }

  private key(tenantId: string, windowStart: number): string {
    return `${QUOTA_KEY_PREFIX}${tenantId}:${windowStart}`;
  }

  private async redisIncr(key: string, ttlMs: number): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const call = (this.client().eval(INCR_SCRIPT, 1, key, String(ttlMs)) as Promise<unknown>).then((v) => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`unexpected quota reply ${JSON.stringify(v)}`);
      return n;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis quota timeout ${REDIS_TIMEOUT_MS}ms`)), REDIS_TIMEOUT_MS);
    });
    // The loser of the race must not surface as an unhandled rejection.
    call.catch(() => undefined);
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private warnOnce(err: unknown): void {
    const t = Date.now();
    if (t - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = t;
    this.logger.warn(
      `read quota: Redis unavailable (${(err as Error)?.message ?? String(err)}); using the per-process window`,
    );
  }

  /** The pre-T6 per-process window, used only while Redis is unavailable. */
  private consumeLocal(tenantId: string, now: number): QuotaDecision {
    let bucket = this.buckets.get(tenantId);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(tenantId, bucket);
    }

    const resetAt = bucket.windowStart + this.windowMs;
    if (bucket.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt, limit: this.limit };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.limit - bucket.count, resetAt, limit: this.limit };
  }

  /** Test/ops helper — never used on a real request path. Deletes the CURRENT window's key. */
  async reset(tenantId: string, now = Date.now()): Promise<void> {
    this.buckets.delete(tenantId);
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    await this.client().del(this.key(tenantId, windowStart)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    if (this.redis.status !== "ready") this.redis.disconnect();
    else await this.redis.quit().catch(() => this.redis?.disconnect());
  }
}
