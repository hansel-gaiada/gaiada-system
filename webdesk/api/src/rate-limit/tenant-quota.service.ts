// WSK-05 amendment (2026-08-26 reassessment §04: "Per-tenant read quotas / noisy-neighbour
// limits — rate limiting is specified for forms only, not content reads"). Fixed-window counter,
// keyed by TENANT (not by api key — a tenant rotating through several keys must not multiply its
// own quota), so one tenant hammering content reads cannot starve every other tenant sharing the
// same box (§11a).
//
// In-memory, per-process: correct for a single api instance (today's dev/M0 topology — WSK-01's
// compose file runs exactly one `api` container). The moment this service runs more than one
// replica, per-process counters under-enforce (each replica has its own budget), which is a real
// gap flagged here rather than hidden: a Redis-backed implementation (INCR + PEXPIRE on a
// `webdesk:quota:<tenantId>:<windowStart>` key) is the natural drop-in, behind the same
// `TenantQuotaService` shape, and REDIS_URL is already provisioned in this project's compose file
// (WSK-01) for exactly this kind of use — just not wired here, to keep this ticket's verification
// runnable against Postgres alone as the task specified.
import { Injectable } from "@nestjs/common";
import { config } from "../config";

export type QuotaDecision = { allowed: boolean; remaining: number; resetAt: number; limit: number };

type Bucket = { windowStart: number; count: number };

@Injectable()
export class TenantQuotaService {
  private readonly buckets = new Map<string, Bucket>();
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

  consume(tenantId: string, now = Date.now()): QuotaDecision {
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

  /** Test/ops helper — never used on a real request path. */
  reset(tenantId: string): void {
    this.buckets.delete(tenantId);
  }
}
