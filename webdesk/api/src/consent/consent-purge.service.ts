// M5-G6 — the consent-log retention purge, run by the hourly maintenance job (scheduler/maintenance-jobs.service.ts,
// the forms-retention-purge job). It is the ONLY code besides privacy.erase that deletes consent_records.
//
// Retention is per CONSENT ID: a browser's whole history goes once its LATEST record is older than the cutoff
// (WEBDESK_CONSENT_RETENTION_MONTHS, default 26 = data lifetime 14 + 1 year), so a history is never left with a
// hole in the middle and an active browser is never purged. consent_records has no platform-context escape, so
// the sweep walks tenants under platform_ctx and enters each tenant's own context (same shape as
// forms/submissions-purge.service.ts). Idempotent and safe to run in two processes at once (a second DELETE finds
// the rows gone).
import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { resolveConsentRetentionMonths } from "./consent.config";

export type ConsentPurgeResult = { tenantId: string; purgedCount: number };

@Injectable()
export class ConsentPurgeService {
  private readonly logger = new Logger(ConsentPurgeService.name);

  constructor(private readonly db: DbService) {}

  /** One sweep across every tenant; returns per-tenant counts. Throws ConsentConfigError on a malformed horizon
   *  (loud, before anything is deleted). */
  async purgeExpiredConsent(): Promise<ConsentPurgeResult[]> {
    const months = resolveConsentRetentionMonths(); // validated first: an empty env is the default, never 0
    const tenantIds = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active'`);
      return rows.map((r) => r.id);
    });

    const results: ConsentPurgeResult[] = [];
    for (const tenantId of tenantIds) {
      const purgedCount = await this.db.withTenant(tenantId, async (db) => {
        const { rowCount } = await db.query(
          `DELETE FROM consent_records
            WHERE tenant_id = $1
              AND consent_id IN (
                SELECT consent_id FROM consent_records
                 WHERE tenant_id = $1
                 GROUP BY consent_id
                HAVING max(recorded_at) < now() - make_interval(months => $2::int)
              )`,
          [tenantId, months],
        );
        return rowCount ?? 0;
      });
      if (purgedCount > 0) this.logger.log(`consent retention purge: tenant ${tenantId} - ${purgedCount} record(s) deleted`);
      results.push({ tenantId, purgedCount });
    }
    return results;
  }
}
