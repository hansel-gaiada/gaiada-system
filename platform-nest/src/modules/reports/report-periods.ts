// TR-15 — `report_periods` reads + the two writers §0057 rule 1/4 name: calendar auto-vivify
// (this file's lazy backstop, mirroring `document-builder.ts`'s `ensureTodayFresh`) and the
// explicit `pin` endpoint. Sealing itself (the third writer, `report_documents` + the `sealed`
// status flip) is `report-seal.ts`'s job — kept in a separate file because it is the one with
// real transactional/outbox weight; this file is the thinner "list/get/pin" surface underneath it.
//
// ─────────────────────── WHY CALENDAR PERIODS NEED A LAZY-BACKSTOP WRITER ───────────────────────
// §0057 rule 1 says the only WRITER of `period_kind='custom'` rows is the explicit pin endpoint —
// it says nothing about calendar (day/week/month) rows, and the endpoint surface (§6.2) has no
// `POST /periods` to create one ahead of time. `POST /periods/:id/seal` acts on an existing
// `report_periods.id`, so something has to mint that row before a client can ever call seal on
// it. The chosen design (a genuine judgment call the doc leaves open, not a schema/contract
// decision — no migration involved): `GET /reports/periods?kind&from&to` auto-vivifies every
// calendar period whose `period_start` falls in [from,to] for the requested `kind`, upserting
// idempotently against 0067's `report_periods_calendar_uq` partial index so the ids it returns
// are STABLE and re-listing the same range never creates a duplicate. This is the exact same
// "lazy idempotent upsert-on-read" shape `document-builder.ts`'s `ensureTodayFresh` already uses
// for `report_work_facts` — a read that provisions its own backing rows is an established house
// pattern in this module, not a new one. `period_kind='custom'` rows are NEVER auto-vivified here
// (only `pinCustomPeriod` writes those, per rule 1) and a `GET .../periods/:id` single-row fetch
// never vivifies either — it only reads whatever the list call (or a pin) already created.
import { withTenants } from "../../db";
import { config } from "../../config";
import { addDaysIso } from "../../core/dept-resolution";
import { mondayOnOrBefore, resolveCalendarRange } from "./document-builder";
import type { ReportPeriodKind } from "./report-document";

export type PeriodStatus = "open" | "sealed" | "amended";
export type CalendarKind = "day" | "week" | "month";

export interface PeriodRow {
  id: string;
  tenantId: string;
  periodKind: ReportPeriodKind;
  label: string | null;
  periodStart: string;
  periodEnd: string;
  status: PeriodStatus;
  revision: number;
  sealedAt: string | null;
  sealedBy: string | null;
  amendReason: string | null;
  sealHash: string | null;
}

/** Column list with camelCase aliases, shared by every SELECT in this file (and by
 *  `report-seal.ts`) so the DB->TS shape is declared exactly once. */
export const PERIOD_COLUMNS = `
  id, tenant_id AS "tenantId", period_kind AS "periodKind", label,
  period_start::text AS "periodStart", period_end::text AS "periodEnd",
  status, revision, sealed_at::text AS "sealedAt", sealed_by AS "sealedBy",
  amend_reason AS "amendReason", seal_hash AS "sealHash"
`;

const PERIOD_MODULE_SCOPE = ["reports"] as const;

// ═══════════════════════════════ PURE — calendar candidate enumeration ═══════════════════════

/** The month-start ('YYYY-MM-01') immediately after `monthStartIso`. Pure; no clock. */
function nextMonthStart(monthStartIso: string): string {
  const d = new Date(`${monthStartIso}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Every calendar `period_start` of `kind` whose period overlaps or falls within [from, to] —
 *  pure, no DB. Bounded by construction: the controller caps [from,to] at
 *  `MAX_CUSTOM_RANGE_DAYS` (400) before this ever runs, so day-kind emits at most 400 starts,
 *  week ~57, month ~14. */
export function enumerateCalendarStarts(kind: CalendarKind, from: string, to: string): string[] {
  const starts: string[] = [];
  if (kind === "day") {
    for (let d = from; d <= to; d = addDaysIso(d, 1)) starts.push(d);
    return starts;
  }
  if (kind === "week") {
    for (let s = mondayOnOrBefore(from); s <= to; s = addDaysIso(s, 7)) starts.push(s);
    return starts;
  }
  // month
  for (let s = `${from.slice(0, 7)}-01`; s <= to; s = nextMonthStart(s)) starts.push(s);
  return starts;
}

// ═══════════════════════════════ I/O — reads ═══════════════════════════════

export async function getPeriodById(tenantId: string, id: string): Promise<PeriodRow | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<PeriodRow>(`SELECT ${PERIOD_COLUMNS} FROM report_periods WHERE tenant_id = $1 AND id = $2`, [tenantId, id]),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );
  return rows[0] ?? null;
}

/** Plain lookup, NO vivify — used by the document-read sealed branch (reports.controller.ts) to
 *  decide "is there a stored snapshot for this exact calendar period, and is it actually
 *  sealed/amended (not merely open)". Returns null for `custom` (callers never look one up this
 *  way — a custom read is always live) and for a period that doesn't exist yet. */
export async function getCalendarPeriod(tenantId: string, kind: CalendarKind, start: string): Promise<PeriodRow | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<PeriodRow>(`SELECT ${PERIOD_COLUMNS} FROM report_periods WHERE tenant_id = $1 AND period_kind = $2 AND period_start = $3::date`, [tenantId, kind, start]),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );
  return rows[0] ?? null;
}

/** `GET /reports/periods?kind&from&to` (§6.2). For a calendar `kind`, auto-vivifies every
 *  candidate period in range (see file header) and returns the real, stable-id rows. For
 *  `kind==='custom'` or an omitted kind, lists whatever rows already exist (custom rows are
 *  never vivified — only `pinCustomPeriod` writes those). */
export async function listPeriods(tenantId: string, kind: string | undefined, from: string, to: string): Promise<PeriodRow[]> {
  if (kind === "day" || kind === "week" || kind === "month") {
    return ensureCalendarPeriodRows(tenantId, kind, from, to);
  }
  const params: unknown[] = [tenantId, to, from];
  let where = `tenant_id = $1 AND period_start <= $2::date AND period_end >= $3::date`;
  if (kind) {
    params.push(kind);
    where += ` AND period_kind = $${params.length}`;
  }
  const { rows } = await withTenants(
    [tenantId],
    (c) => c.query<PeriodRow>(`SELECT ${PERIOD_COLUMNS} FROM report_periods WHERE ${where} ORDER BY period_start`, params),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );
  return rows;
}

/** The lazy-backstop writer (see file header). One bulk `INSERT ... ON CONFLICT DO NOTHING`
 *  targeting `report_periods_calendar_uq` (idempotent — re-listing the same range never
 *  duplicates or errors) + one SELECT to return every candidate's real row, whether just-created
 *  or pre-existing. `origin_site` has no default (§15 ruling) — `config.originSite` passed
 *  explicitly, same as every other writer in this program. */
export async function ensureCalendarPeriodRows(tenantId: string, kind: CalendarKind, from: string, to: string): Promise<PeriodRow[]> {
  const starts = enumerateCalendarStarts(kind, from, to);
  if (starts.length === 0) return [];
  const ends = starts.map((s) => resolveCalendarRange(kind, s).end);

  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `INSERT INTO report_periods (id, tenant_id, period_kind, period_start, period_end, status, revision, origin_site)
         SELECT gen_random_uuid(), $1, $2, t.s, t.e, 'open', 0, $3
           FROM unnest($4::date[], $5::date[]) AS t(s, e)
         ON CONFLICT (tenant_id, period_kind, period_start) WHERE period_kind <> 'custom' DO NOTHING`,
        [tenantId, kind, config.originSite, starts, ends],
      ),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );

  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<PeriodRow>(
        `SELECT ${PERIOD_COLUMNS} FROM report_periods
          WHERE tenant_id = $1 AND period_kind = $2 AND period_start = ANY($3::date[])
          ORDER BY period_start`,
        [tenantId, kind, starts],
      ),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );
  return rows;
}

/** `POST /reports/periods/pin {start, end, label}` (§0057 rule 4). Idempotent on the EXACT range
 *  via `report_periods_custom_uq` — re-pinning the same window updates the label (a labelling
 *  correction) rather than erroring or duplicating, mirroring the DB-level idempotency
 *  `report-periods-rls.test.ts` already proved for this exact index. Never auto-called from a
 *  read path — this is the ONLY writer of `period_kind='custom'` rows (rule 1). */
export async function pinCustomPeriod(tenantId: string, start: string, end: string, label: string): Promise<PeriodRow> {
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<PeriodRow>(
        `INSERT INTO report_periods (id, tenant_id, period_kind, label, period_start, period_end, status, revision, origin_site)
         VALUES (gen_random_uuid(), $1, 'custom', $2, $3::date, $4::date, 'open', 0, $5)
         ON CONFLICT (tenant_id, period_start, period_end) WHERE period_kind = 'custom'
           DO UPDATE SET label = EXCLUDED.label, updated_at = now()
         RETURNING ${PERIOD_COLUMNS}`,
        [tenantId, label, start, end, config.originSite],
      ),
    { modules: [...PERIOD_MODULE_SCOPE] },
  );
  return rows[0];
}
