// WSK-10 — the retention purge worker (§11 AC: "retention_days honoured ... plus a purge job").
// `submissions` carries NO platform-context escape in its RLS policy (0003_forms.sql: single-mode
// `tenant_id = webdesk_tenant_ctx()`, same as `form_defs` — see form-lookup.service.ts's header),
// so a cross-tenant sweep cannot be one query. This mirrors
// test/helpers/fixtures.ts's `dumpAllApiKeyRowsAcrossTenants` shape exactly: list every tenant
// under platform_ctx (the ONE table with that escape hatch), then loop, entering each tenant's own
// context to touch only that tenant's rows — the only way to walk every tenant's data without ever
// bypassing RLS.
//
// Purge SCRUBS rather than DELETEs: `payload` is overwritten to `{}` and the consent text is
// replaced with a tombstone marker, `status` flips to `purged`, but the row itself (id,
// created_at, expires_at, form_def_id) survives — matching audit_entries/content_versions'
// append-only-history precedent elsewhere in this schema, and leaving something for a future
// count/audit view to point at. A hard DELETE is the more literal reading of "purge" and is a
// one-line change if that is the desired posture — flagged as a design choice in the ticket
// report, not a design DECISION (no doc text mandates either shape).
//
// NOT wired to any scheduler here — main.ts/the `worker` service's BullMQ bootstrap is out of this
// ticket's owned scope (src/forms/** only), same gap WSK-11 flagged for its own mail worker
// ("the BullMQ worker runs in-process with api, not in the worker service"). This service exposes
// a single idempotent method a cron/BullMQ-repeatable job can call; wiring that trigger is a
// follow-up for whoever owns main.ts/queue/**.
import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../db/db.service";

const TOMBSTONE_TEXT = "[purged — retention period elapsed]";

export type PurgeResult = { tenantId: string; purgedCount: number };

@Injectable()
export class SubmissionsPurgeService {
  private readonly logger = new Logger(SubmissionsPurgeService.name);

  constructor(private readonly db: DbService) {}

  /** Runs one sweep across every tenant. Returns a per-tenant count so a caller (a test, or a
   *  future ops surface) can see exactly what happened, not just an aggregate. */
  async purgeDueSubmissions(): Promise<PurgeResult[]> {
    const tenantIds = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active'`);
      return rows.map((r) => r.id);
    });

    const results: PurgeResult[] = [];
    for (const tenantId of tenantIds) {
      const purgedCount = await this.db.withTenant(tenantId, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `UPDATE submissions
             SET status = 'purged', payload = '{}'::jsonb, consent_notice_text = $1
           WHERE tenant_id = $2 AND status <> 'purged' AND expires_at < now()
           RETURNING id`,
          [TOMBSTONE_TEXT, tenantId],
        );
        return rows.length;
      });
      if (purgedCount > 0) {
        this.logger.log(`retention purge: tenant ${tenantId} — ${purgedCount} submission(s) scrubbed`);
      }
      results.push({ tenantId, purgedCount });
    }
    return results;
  }
}
