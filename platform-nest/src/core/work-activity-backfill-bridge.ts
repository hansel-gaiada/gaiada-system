// DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.7) — one-time history: replay the audit log (`activities`) through the SAME
// catalogue the live bridge uses (`activity-kinds.ts` via `activity-bridge.ts`), so a person's work from before the bridge
// shows in the activity series.
//
//   node dist/core/work-activity-backfill-bridge.js [--since=YYYY-MM-DD] [--tenant=<company uuid>]
//
// A server step (run it where DATABASE_URL points at the live database), not a boot hook: it is NOT wired into main.ts.
//   --since   the earliest audit row to replay; default today minus 400 days (the longest window the series reads).
//   --tenant  one company only; default every live company.
//
// IDEMPOTENT. Each replayed row carries the live bridge's own `sourceRef` (`act:<activities.id>`, or `act:<entity>:<id>`
// for the one-row-per-entity kinds), and the `occurredAt` is the audit row's own time (or the entry's date), which is stable.
// Re-running adds nothing: rows already bridged are skipped by an anti-join, the rest dedupe on UNIQUE(tenant_id, source,
// source_ref). Past sealed report periods do not change (their documents are stored); the nightly facts pick the rows up.
//
// THE TENANT GUC. `activities` is tenant-RLS: an unset `app.current_tenant_ids` reads ZERO rows and says nothing. Every read
// here runs in `withTenants([tenantId])`, and asserts the GUC is the tenant it meant before trusting an empty result.
import { closePool, newId, withGlobal, withTenants } from "../db";
import { ACTIVITY_BRIDGE } from "./activity-kinds";
import { bridgeActivity } from "./activity-bridge";

const BATCH = 500;
const WINDOW_DAYS = 400;

export interface BackfillOptions {
  /** YYYY-MM-DD. Default: today (UTC) minus 400 days. */
  since?: string;
  /** One company; default every live company. */
  tenantId?: string;
}

export interface BackfillReport {
  since: string;
  tenants: number;
  /** Audit rows read that matched a catalogue pair. */
  scanned: number;
  /** Rows written (new), per kind. */
  inserted: Record<string, number>;
  /** Rows that were already there (an entity-keyed row seen again), per kind. */
  alreadyThere: Record<string, number>;
  /** Matched rows the catalogue skipped (a predicate that failed, a time entry that is gone). */
  skipped: number;
  /** Rows whose ingest threw; the run carries on. */
  errors: number;
}

interface AuditRow {
  id: string;
  actor_id: string;
  verb: string;
  target_entity_type: string;
  target_entity_id: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
  /** The same instant as text, to microseconds: the keyset cursor must not lose the digits a JS Date drops. */
  occurred_text: string;
}

export function defaultSince(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

/** The distinct (entity, verb) pairs the catalogue bridges, as two parallel SQL arrays. */
function pairArrays(): [string[], string[]] {
  const seen = new Set<string>();
  const entities: string[] = [];
  const verbs: string[] = [];
  for (const e of ACTIVITY_BRIDGE) {
    const k = `${e.entity}|${e.auditVerb}`;
    if (seen.has(k)) continue;
    seen.add(k);
    entities.push(e.entity);
    verbs.push(e.auditVerb);
  }
  return [entities, verbs];
}

async function backfillTenant(tenantId: string, since: string, report: BackfillReport): Promise<void> {
  const [entities, verbs] = pairArrays();
  let cursor: { at: string; id: string } | null = null;

  for (;;) {
    const page: AuditRow[] = await withTenants([tenantId], async (c) => {
      const guc = await c.query<{ g: string | null }>(`SELECT current_setting('app.current_tenant_ids', true) AS g`);
      if (guc.rows[0]?.g !== tenantId) throw new Error(`tenant GUC is not set to ${tenantId}: refusing to read an empty set`);
      const r = await c.query<AuditRow>(
        `SELECT a.id, a.actor_id, a.verb, a.target_entity_type, a.target_entity_id, a.metadata, a.occurred_at, a.occurred_at::text AS occurred_text
           FROM activities a
          WHERE a.occurred_at >= $1::date
            AND a.actor_id IS NOT NULL
            AND (a.target_entity_type, a.verb) IN (SELECT p.e, p.v FROM unnest($2::text[], $3::text[]) AS p(e, v))
            AND ($4::timestamptz IS NULL OR (a.occurred_at, a.id) > ($4::timestamptz, $5::uuid))
            -- the rows the live bridge (or an earlier run) already wrote: source_ref is TEXT and activities.id is UUID, so cast the UUID side
            AND NOT EXISTS (SELECT 1 FROM work_activity wa WHERE wa.source_ref = 'act:' || a.id::text)
          ORDER BY a.occurred_at, a.id
          LIMIT ${BATCH}`,
        [since, entities, verbs, cursor?.at ?? null, cursor?.id ?? newId()],
      );
      return r.rows;
    });
    if (page.length === 0) return;

    for (const row of page) {
      report.scanned++;
      try {
        const out = await bridgeActivity({
          tenantId,
          activityId: row.id,
          actorId: row.actor_id,
          verb: row.verb,
          entityType: row.target_entity_type,
          entityId: row.target_entity_id,
          metadata: row.metadata ?? {},
          occurredAt: new Date(row.occurred_at).toISOString(),
        });
        if (!out) report.skipped++;
        else if (out.deduped) report.alreadyThere[out.kind] = (report.alreadyThere[out.kind] ?? 0) + 1;
        else report.inserted[out.kind] = (report.inserted[out.kind] ?? 0) + 1;
      } catch (err) {
        report.errors++;
        // eslint-disable-next-line no-console
        console.error(`[ACTIVITY-BRIDGE-BACKFILL] ${row.target_entity_type}/${row.verb} ${row.id}: ${(err as Error)?.message ?? "error"}`);
      }
    }
    const last = page[page.length - 1];
    cursor = { at: last.occurred_text, id: last.id };
    if (page.length < BATCH) return;
  }
}

/** Replays the audit log since `opts.since` through the catalogue, per company. */
export async function runBridgeBackfill(opts: BackfillOptions = {}): Promise<BackfillReport> {
  const since = opts.since ?? defaultSince();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00.000Z`))) {
    throw new Error(`--since must be a YYYY-MM-DD date, got "${since}"`);
  }
  const companies = opts.tenantId
    ? [{ id: opts.tenantId }]
    : (await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`))).rows;
  const report: BackfillReport = { since, tenants: companies.length, scanned: 0, inserted: {}, alreadyThere: {}, skipped: 0, errors: 0 };
  for (const { id } of companies) await backfillTenant(id, since, report);
  return report;
}

export function formatReport(r: BackfillReport): string {
  const lines = [`work_activity bridge backfill since ${r.since}: ${r.tenants} companies, ${r.scanned} audit rows replayed, ${r.skipped} skipped, ${r.errors} errors`];
  const kinds = [...new Set([...Object.keys(r.inserted), ...Object.keys(r.alreadyThere)])].sort();
  if (kinds.length === 0) lines.push("  (no rows written)");
  for (const k of kinds) lines.push(`  ${k}: ${r.inserted[k] ?? 0} new, ${r.alreadyThere[k] ?? 0} already there`);
  return lines.join("\n");
}

/** `--since=2026-01-01 --tenant=<uuid>` -> options. Unknown flags are an error, so a typo never runs a full replay. */
export function parseArgs(argv: string[]): BackfillOptions {
  const opts: BackfillOptions = {};
  for (const a of argv) {
    const m = /^--(since|tenant)=(.+)$/.exec(a);
    if (!m) throw new Error(`unknown argument "${a}" (use --since=YYYY-MM-DD and --tenant=<uuid>)`);
    if (m[1] === "since") opts.since = m[2];
    else opts.tenantId = m[2];
  }
  return opts;
}

if (require.main === module) {
  (async () => {
    try {
      const report = await runBridgeBackfill(parseArgs(process.argv.slice(2)));
      console.log(formatReport(report));
      process.exitCode = report.errors > 0 ? 1 : 0;
    } catch (err) {
      console.error(`work-activity bridge backfill failed: ${(err as Error)?.message ?? err}`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  })();
}
