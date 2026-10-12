// M6-P4r-b -- the fail-soft front door the commands use. `tenant.provision`, `schema.apply` and
// `contract.regenerate` call it from the command envelope's `after` hook, which runs strictly AFTER
// the command's transaction (audit row, effect and idempotency record) committed.
//
// FAIL-SOFT, structurally: neither method ever rejects or throws. A Redis outage, a bad config, a
// queue that is closing, all end in a warning in the log and nothing else, so the command's response,
// status and stored idempotency record are what they would have been had codegen not existed. The
// enqueue is also bounded (ENQUEUE_TIMEOUT_MS): BullMQ's connection retries forever by design, and an
// unbounded await here would hold the HTTP response of an already-committed command hostage to Redis.
// A replayed command never reaches `after` (the envelope answers it from the stored record), so a
// replay enqueues nothing; two distinct commands for one tenant coalesce in the queue itself.
import { Injectable, Logger } from "@nestjs/common";
import { ContractCodegenQueue } from "./contract-codegen.queue";
import { ENQUEUE_TIMEOUT_MS } from "./contract-codegen.config";
import type { ContractCodegenSource } from "./contract-codegen.types";

export interface EnqueueReport {
  enqueued: number;
  failed: number;
}

@Injectable()
export class ContractCodegenTrigger {
  private readonly logger = new Logger(ContractCodegenTrigger.name);

  constructor(private readonly queue: ContractCodegenQueue) {}

  /** `true` when a run is queued, coalesced into a waiting one, or the feature is off; `false` when the enqueue failed. Never rejects. */
  async requestRun(tenantSlug: string, source: ContractCodegenSource): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = Promise.resolve().then(() => this.queue.enqueue(tenantSlug));
      // A late rejection after the timeout won must not become an unhandled rejection.
      pending.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`enqueue did not complete within ${ENQUEUE_TIMEOUT_MS} ms`)), ENQUEUE_TIMEOUT_MS);
      });
      const outcome = await Promise.race([pending, timeout]);
      this.logger.debug(`contract codegen ${outcome} for tenant '${tenantSlug}' (${source})`);
      return true;
    } catch (err) {
      this.logger.warn(
        `contract codegen could not be queued for tenant '${tenantSlug}' (${source}); the command is unaffected. ` +
          `Re-run it with the contract.regenerate control command. Cause: ${String(err)}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One enqueue per tenant, in order. Never rejects; stops early once the queue is clearly unavailable. */
  async requestRuns(tenantSlugs: readonly string[], source: ContractCodegenSource): Promise<EnqueueReport> {
    const report: EnqueueReport = { enqueued: 0, failed: 0 };
    for (const [i, slug] of tenantSlugs.entries()) {
      if (await this.requestRun(slug, source)) report.enqueued++;
      else {
        // One failure usually means Redis is down: do not spend ENQUEUE_TIMEOUT_MS on every remaining tenant.
        report.failed += tenantSlugs.length - i;
        break;
      }
    }
    return report;
  }
}
