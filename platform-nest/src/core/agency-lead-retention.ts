// M5-G5 — the retention purge for UNCONVERTED agency leads (legal/website-visitor-addendum.md §5, R-V10):
// "agency_leads unconverted: 24 months, then delete; trigger: last status change", and "AD-1 submissions of
// declined / unconverted leads: same as the lead, on the lead's clock". Converted leads follow client-record
// retention and are never touched here. The addendum keeps attribution and the consent snapshot "with the same
// retention" (§9.3 item 7), so nothing is dropped earlier than the lead itself.
//
// ── WHAT IS PURGED ───────────────────────────────────────────────────────────────────────────────────
// A lead is due when ALL hold (per tenant):
//   - status <> 'converted' (so converted_client_id IS NULL, by CHECK lead_converted_has_client);
//   - status_changed_at (the DB-maintained clock, migration 202610121835) is older than the cutoff;
//   - it is not ACTIVE: no intake token was minted, and no AD-1 submission arrived, after the cutoff. (A late
//     submission to a declined lead does not change its status, so the clock alone would miss it.)
// Soft-deleted leads are included: they still hold personal data.
//
// ── HOW ──────────────────────────────────────────────────────────────────────────────────────────────
// One transaction per batch, per tenant (`withTenants([tenantId])`, NO modules: the agency tables are a plain
// tenant wall). It first sets `app.lead_purge = 'on'` with set_config(..., true), i.e. SET LOCAL: the one
// escape hatch of agency_lead_stage_events' append-only DELETE trigger (202610111425), scoped to exactly this
// transaction so it can never leak to the next borrower of the pooled connection. Then, children first:
// AD-1 submissions (they reference tokens), intake tokens, stage history, the leads. One evidence row
// (counts only) goes to agency_lead_retention_runs in the same transaction.
//
// ⚠ THE RLS ZERO-ROW TRAP. Every statement runs under the tenant GUC that withTenants sets, so the sweep lists
// companies with `withGlobal` (companies carry no tenant_id) and opens one tenant transaction per company. A
// sweep that skipped the GUC would read zero rows and report "nothing due" forever. The DB test drives a due
// lead through the real path to prove the GUC is set.
//
// ── CONFIGURATION (read at call time; an empty value never becomes 0) ───────────────────────────────────
//   AGENCY_LEAD_RETENTION_PURGE_ENABLED   "1"/"true" starts the loop (dark by default, the estate's sweep
//                                         convention; turn on with the addendum's sign-off, G2).
//   AGENCY_LEAD_RETENTION_MONTHS          whole months >= 1; default 24. "", "0", "-3", "1.5", "abc" -> 24.
//   AGENCY_LEAD_RETENTION_INTERVAL_MS     loop period; default 24h; non-positive/empty -> default.
//   AGENCY_LEAD_RETENTION_BATCH           leads per transaction; default 200.
// The empty-string case is the compose `${VAR:-}` trap: `Number("")` is 0, and a zero retention would delete
// every unconverted lead on the first tick.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";

export const DEFAULT_RETENTION_MONTHS = 24;
const DEFAULT_INTERVAL_MS = 24 * 3600 * 1000;
const DEFAULT_BATCH = 200;
/** A guard against a runaway loop inside one tenant: at most this many batches per run. */
const MAX_BATCHES_PER_TENANT = 50;

/** A whole number >= 1 from the environment, else `fallback`. Never 0, never NaN, never fractional. */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

export interface RetentionConfig {
  enabled: boolean;
  months: number;
  intervalMs: number;
  batch: number;
}

export function leadRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const flag = (env.AGENCY_LEAD_RETENTION_PURGE_ENABLED ?? "").trim().toLowerCase();
  return {
    enabled: flag === "1" || flag === "true",
    months: positiveIntEnv(env.AGENCY_LEAD_RETENTION_MONTHS, DEFAULT_RETENTION_MONTHS),
    intervalMs: positiveIntEnv(env.AGENCY_LEAD_RETENTION_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    batch: positiveIntEnv(env.AGENCY_LEAD_RETENTION_BATCH, DEFAULT_BATCH),
  };
}

export interface PurgeCounts {
  leads: number;
  submissions: number;
  tokens: number;
  stageEvents: number;
}

const ZERO: PurgeCounts = { leads: 0, submissions: 0, tokens: 0, stageEvents: 0 };

/**
 * One batch for one tenant, on a transaction the CALLER opened with `withTenants([tenantId])`. Sets the purge
 * hatch itself (SET LOCAL), so the hatch is always scoped to exactly the transaction doing the deleting.
 * Exported for the DB test.
 */
export async function purgeDueLeadsBatch(
  c: PoolClient,
  tenantId: string,
  opts: { now: Date; months: number; batch: number },
): Promise<PurgeCounts & { cutoff: Date }> {
  const cut = await c.query<{ cutoff: Date }>(
    `SELECT ($1::timestamptz - make_interval(months => $2::int)) AS cutoff`,
    [opts.now, opts.months],
  );
  const cutoff = cut.rows[0].cutoff;

  const due = await c.query<{ id: string }>(
    `SELECT l.id FROM agency_leads l
      WHERE l.tenant_id = $1
        AND l.status <> 'converted'
        AND l.converted_client_id IS NULL
        AND l.status_changed_at < $2
        AND NOT EXISTS (SELECT 1 FROM agency_intake_tokens t
                         WHERE t.tenant_id = l.tenant_id AND t.lead_id = l.id AND t.created_at >= $2)
        AND NOT EXISTS (SELECT 1 FROM agency_discovery_submissions s
                         WHERE s.tenant_id = l.tenant_id AND s.lead_id = l.id AND s.created_at >= $2)
      ORDER BY l.id
      LIMIT $3
      FOR UPDATE OF l SKIP LOCKED`,
    [tenantId, cutoff, opts.batch],
  );
  const ids = due.rows.map((r) => r.id);
  if (ids.length === 0) return { ...ZERO, cutoff };

  // The ONE place the append-only history may be deleted from (202610111425's hatch). SET LOCAL semantics.
  await c.query(`SELECT set_config('app.lead_purge', 'on', true)`);
  const subs = await c.query(
    `DELETE FROM agency_discovery_submissions WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])`, [tenantId, ids],
  );
  const tokens = await c.query(
    `DELETE FROM agency_intake_tokens WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])`, [tenantId, ids],
  );
  const events = await c.query(
    `DELETE FROM agency_lead_stage_events WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])`, [tenantId, ids],
  );
  const leads = await c.query(
    `DELETE FROM agency_leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status <> 'converted'`, [tenantId, ids],
  );
  // Close the hatch again for anything later in this transaction.
  await c.query(`SELECT set_config('app.lead_purge', 'off', true)`);

  const counts: PurgeCounts = {
    leads: leads.rowCount ?? 0,
    submissions: subs.rowCount ?? 0,
    tokens: tokens.rowCount ?? 0,
    stageEvents: events.rowCount ?? 0,
  };
  await c.query(
    `INSERT INTO agency_lead_retention_runs
       (id, tenant_id, ran_at, retention_months, cutoff, leads_deleted, submissions_deleted, tokens_deleted, stage_events_deleted, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId(), tenantId, opts.now, opts.months, cutoff, counts.leads, counts.submissions, counts.tokens, counts.stageEvents, config.originSite],
  );
  return { ...counts, cutoff };
}

/** One tenant: batches until a short batch, each in its own transaction. */
export async function purgeTenantDueLeads(
  tenantId: string,
  opts: { now: Date; months: number; batch: number },
): Promise<PurgeCounts> {
  const total = { ...ZERO };
  for (let i = 0; i < MAX_BATCHES_PER_TENANT; i++) {
    const r = await withTenants([tenantId], (c) => purgeDueLeadsBatch(c, tenantId, opts));
    total.leads += r.leads;
    total.submissions += r.submissions;
    total.tokens += r.tokens;
    total.stageEvents += r.stageEvents;
    if (r.leads < opts.batch) break;
  }
  return total;
}

/** Every tenant. Per-tenant failures are logged (tenant id and error class only) and do not stop the sweep. */
export async function runLeadRetentionPurge(
  now: Date = new Date(),
  cfg: Pick<RetentionConfig, "months" | "batch"> = leadRetentionConfig(),
): Promise<{ tenants: number; errors: number; totals: PurgeCounts }> {
  const { rows: tenants } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies ORDER BY id`));
  const totals = { ...ZERO };
  let errors = 0;
  for (const { id } of tenants) {
    try {
      const r = await purgeTenantDueLeads(id, { now, months: cfg.months, batch: cfg.batch });
      totals.leads += r.leads;
      totals.submissions += r.submissions;
      totals.tokens += r.tokens;
      totals.stageEvents += r.stageEvents;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[AGENCY-LEAD-RETENTION] tenant ${id} failed: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { tenants: tenants.length, errors, totals };
}

/** The loop. Started by main.ts only when AGENCY_LEAD_RETENTION_PURGE_ENABLED is set. */
export function startLeadRetentionPurgeLoop(cfg: RetentionConfig = leadRetentionConfig()): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runLeadRetentionPurge(new Date(), cfg);
      // eslint-disable-next-line no-console
      console.log("[AGENCY-LEAD-RETENTION] purge run:", JSON.stringify({ months: cfg.months, ...r }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[AGENCY-LEAD-RETENTION] tick failed: ${(err as Error)?.name ?? "error"}`);
    }
    if (!stopped) timer = setTimeout(tick, cfg.intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
