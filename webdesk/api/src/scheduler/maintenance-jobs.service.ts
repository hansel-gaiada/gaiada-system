// WSK-61 — the two hourly maintenance jobs. Both were written earlier, tested, and never called:
//   * SubmissionsPurgeService.purgeDueSubmissions()  (WSK-10, forms retention: scrubs expired submissions)
//   * PgIdempotencyStore.sweepExpired()              (WSK-41, deletes expired control_idempotency_keys)
// Each walks every tenant under that tenant's own webdesk.tenant_ctx (the app role cannot see across
// tenants), so neither can reach another tenant's rows. This service only adds the schedule's contract:
// counts are logged, and a failure is logged AND rethrown so BullMQ records the job as failed. The
// process never crashes on it (the worker catches what a processor throws).
//
// Both are safe to run in two processes at once: the purge is an UPDATE ... WHERE status <> 'purged'
// (a second runner re-evaluates the row after the first commits and skips it) and the sweep is a
// DELETE of expired rows (the second finds them gone).
import { Injectable, Logger } from "@nestjs/common";
import { SubmissionsPurgeService } from "../forms/submissions-purge.service";
import { ConsentPurgeService } from "../consent/consent-purge.service";
import { PgIdempotencyStore } from "../control/idempotency/pg-idempotency-store";

@Injectable()
export class MaintenanceJobsService {
  private readonly logger = new Logger(MaintenanceJobsService.name);

  constructor(
    private readonly purge: SubmissionsPurgeService,
    private readonly idempotency: PgIdempotencyStore,
    private readonly consentPurge: ConsentPurgeService,
  ) {}

  /**
   * The forms retention purge. Returns how many tenants were swept and how many submissions were scrubbed.
   * M5-G6: the same hourly job also purges consent_records past their retention (consent/consent-purge.service.ts).
   * The two are independent: a failure in one never stops the other from running, and either failure is logged
   * and rethrown (the forms failure wins when both fail) so BullMQ records the job as failed. The returned shape
   * is unchanged; the consent count is in the log line.
   */
  async runFormsPurge(): Promise<{ tenants: number; purged: number }> {
    let out: { tenants: number; purged: number } | undefined;
    let formsErr: unknown;
    try {
      const results = await this.purge.purgeDueSubmissions();
      out = { tenants: results.length, purged: results.reduce((n, r) => n + r.purgedCount, 0) };
      this.logger.log(`forms retention purge: tenants=${out.tenants} purged=${out.purged}`);
    } catch (err) {
      this.logger.error(`forms retention purge failed: ${String(err)}`);
      formsErr = err;
    }
    let consentErr: unknown;
    try {
      const results = await this.consentPurge.purgeExpiredConsent();
      this.logger.log(`consent retention purge: tenants=${results.length} deleted=${results.reduce((n, r) => n + r.purgedCount, 0)}`);
    } catch (err) {
      this.logger.error(`consent retention purge failed: ${String(err)}`);
      consentErr = err;
    }
    if (formsErr !== undefined) throw formsErr;
    if (consentErr !== undefined) throw consentErr;
    return out!;
  }

  /** The idempotency expiry sweep. Returns the store's own counts. */
  async runIdempotencySweep(): Promise<{ tenantsSwept: number; tenantRows: number; platformRows: number }> {
    try {
      const out = await this.idempotency.sweepExpired();
      this.logger.log(`idempotency sweep: tenants=${out.tenantsSwept} tenantRows=${out.tenantRows} platformRows=${out.platformRows}`);
      return out;
    } catch (err) {
      this.logger.error(`idempotency sweep failed: ${String(err)}`);
      throw err;
    }
  }
}
