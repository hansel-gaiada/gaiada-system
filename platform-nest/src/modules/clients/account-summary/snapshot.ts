// PV7-07 — the monthly account summary: the FROZEN SNAPSHOT (docs/FRONTEND-BFF-CONTRACT.md §56.1).
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────────────────────────────
// One client, one calendar month, safe to show the client. It is built ONLY from what a client-wide contact of that client
// may see: the reads below run with a synthetic portal scope for that one client (`clientWideScope`), through the same
// predicates and the same PV7-02 loaders the portal's own health read uses. NO visibility SQL is written here that
// portal-visibility.ts does not already own: the project, milestone, deliverable and client-report predicates are its
// builders, and `loadProjectHealth`, `loadClientBall` and `loadTurnaround` run in portal mode.
//
// ── WHAT IS NEVER IN IT ──────────────────────────────────────────────────────────────────────────────
//   * tasks, or any figure derived from them (no `effort.*`, no on-time rate, no blocked count);
//   * time entries and effort;
//   * people: no names, owners, assignees or authors (the ball is reduced to a count and an oldest instant: its items
//     carry labels and contexts we do not copy);
//   * internal gates (the ball and the turnaround loaders already refuse them in portal mode; the snapshot never asks);
//   * money: no payment, no invoice figure, and `search_ads.conversion_value` (and any money-like KPI) is stripped from
//     the results cards (`stripMoneyKpis`). PV-D38, PV7-Q3.
// `account-summary.test.ts` plants one of each in a fixture and scans the whole snapshot for them.
//
// ── EVERY SECTION IS HONEST ABOUT WHAT IT KNOWS ──────────────────────────────────────────────────────
// A section whose read failed is `null` and named in `unavailable[]`, never zero. Milestone completion dates exist only
// from migration 202610151710 (nothing was back-filled): `knownSince` says from when, `wholeMonthKnown` says whether this
// month is fully covered. A deliverable has no delivery timestamp: its section says it is "status changed in the month".
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import type { PortalScope } from "../../../core/portal-scope";
import { scopeValues } from "../../../core/portal-scope";
import {
  clientReportInPortalScope, deliverableClientVisible, milestoneClientVisible, projectInPortalScope, scopeAt,
} from "../../../core/portal-visibility";
import { loadOnTimeKnownSince, loadProjectHealth, loadTurnaround, TURNAROUND_WINDOW_DAYS, type Reach } from "../client-health";
import { loadClientBall, type BallRow } from "../client-ball";
import { composeBusinessResults } from "../centre/results/compose";
import type { BusinessResults, ServiceCard, ServiceKey } from "../centre/results/types";

const logger = new Logger("AccountSummary");

/** The statuses a deliverable counts as delivered in (the health read's own set). */
const DELIVERED_STATUSES = ["delivered", "approved", "done"];
/** At most this many listed rows per section; the `count` is always the true total. */
export const SUMMARY_ITEM_CAP = 200;

// ── The shape (BFF §56.1) ────────────────────────────────────────────────────────────────────────────

export interface SnapshotProject {
  projectId: string;
  name: string;
  status: string;
  milestones: { total: number; done: number; upcoming: number; late: number; undated: number };
  deliverables: { total: number; delivered: number; late: number };
  nextMilestone: { name: string; dueDate: string } | null;
}
export interface SnapshotWaiting { count: number; oldestSince: string | null }
export interface SnapshotTurnaroundSide { medianDays: number | null; n: number; withheld: boolean }
export interface SnapshotReport { id: string; title: string; source: string; periodStart: string; periodEnd: string; publishedOn: string }

export interface AccountSummarySnapshot {
  version: 1;
  clientId: string;
  clientName: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  projects: SnapshotProject[] | null;
  waiting: { onClient: SnapshotWaiting; onUs: SnapshotWaiting } | null;
  completed: {
    milestones: {
      count: number;
      knownSince: string | null;
      wholeMonthKnown: boolean | null;
      items: Array<{ projectId: string; projectName: string; name: string; completedOn: string }>;
    } | null;
    deliverables: {
      count: number;
      basis: "status_changed_in_month";
      items: Array<{ projectId: string; projectName: string; name: string; status: string; on: string }>;
    } | null;
  };
  turnaround: { windowDays: 90; windowEnd: string; client: SnapshotTurnaroundSide; ours: SnapshotTurnaroundSide } | null;
  results: { generatedAt: string; services: ServiceCard[]; unavailable: ServiceKey[] } | null;
  reports: SnapshotReport[] | null;
  unavailable: string[];
}

// ── The period ───────────────────────────────────────────────────────────────────────────────────────

export interface SummaryPeriod {
  period: string;
  /** First and last day of the month, YYYY-MM-DD (UTC, inclusive). */
  periodStart: string;
  periodEnd: string;
  /** The instants [startAt, endExclusive): the first of the month 00:00 UTC to the first of the next month 00:00 UTC. */
  startAt: Date;
  endExclusive: Date;
}

/** `YYYY-MM` -> the calendar month, or null when it is not a real month of a plausible year. */
export function parseSummaryPeriod(period: unknown): SummaryPeriod | null {
  if (typeof period !== "string") return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2000 || year > 2100) return null;
  const startAt = new Date(Date.UTC(year, month - 1, 1));
  const endExclusive = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return {
    period,
    periodStart: startAt.toISOString().slice(0, 10),
    periodEnd: last.toISOString().slice(0, 10),
    startAt,
    endExclusive,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "September 2026". */
export function summaryPeriodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const month = m ? Number(m[2]) : 0;
  return m && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${m[1]}` : period;
}

// ── The client-wide scope ────────────────────────────────────────────────────────────────────────────

/** The scope a client-wide contact of ONE client resolves to: that client in `clientIds` and `wideClientIds`, no explicit
 *  projects (client-wide reach is the `wideClientIds` arm; `projectIds` is for project-scoped rows). Built here, never from a
 *  request: the only input is the client id the staff route already resolved from its own URL and the database. It is
 *  deliberately NOT exported from portal-scope.ts, the isolation kernel, so nothing else can mint a wide scope by accident. */
export function clientWideScope(clientId: string): PortalScope {
  return { clientIds: [clientId], wideClientIds: [clientId], projectIds: [], signerClientIds: [] };
}

// ── Money (PV-D38, PV7-Q3): the summary shows none ──────────────────────────────────────────────────

const MONEY_KEY = /(^|[._])(value|spend|cost|budget|revenue|price|fee|cpa|cpc|cpm|roas|margin|profit|amount|currency)([._]|$)/i;
const MONEY_LABEL = /\b(value|spend|cost|budget|revenue|price|fee|cpa|cpc|cpm|roas|margin|profit|amount|currency)\b/i;
/** A bare ISO currency code in brackets, as the search-ads card writes it: "Conversion value (USD)". Case-sensitive on purpose. */
const CURRENCY_LABEL = /\(\s*[A-Z]{3}\s*\)/;

/** Is this KPI a money figure? `search_ads.conversion_value` is the one the cards carry today; the pattern is the safety
 *  net for a card that grows another (a KPI whose key or label names a value, spend, cost or a currency). */
export function isMoneyKpi(k: { key: string; label: string }): boolean {
  return k.key === "search_ads.conversion_value" || MONEY_KEY.test(k.key) || MONEY_LABEL.test(k.label) || CURRENCY_LABEL.test(k.label);
}

/** The results payload with every money-like KPI removed. The cards are otherwise exactly what a client-wide contact gets. */
export function stripMoneyKpis(r: Pick<BusinessResults, "generatedAt" | "services" | "unavailable">): NonNullable<AccountSummarySnapshot["results"]> {
  return {
    generatedAt: r.generatedAt,
    services: r.services.map((s) => ({ ...s, kpis: s.kpis.filter((k) => !isMoneyKpi(k)) })),
    unavailable: [...r.unavailable],
  };
}

// ── Reading (each source on its own: a failure is `unavailable`, never zero) ────────────────────────

export interface AccountSummaryDeps {
  now?: Date;
  /** Override how a source opens its transaction (a test throws for one source to prove `unavailable`). */
  read?: (tenantId: string, source: string, modules: string[] | undefined, fn: (c: PoolClient) => Promise<unknown>) => Promise<unknown>;
  /** Override the results composer (tests). */
  compose?: typeof composeBusinessResults;
  /** Override the instant milestone completion dates are known from (tests). `null` = unknown. */
  knownSince?: () => Promise<string | null>;
}

class SummaryReads {
  readonly unavailable: string[] = [];
  constructor(readonly tenantId: string, private readonly deps: AccountSummaryDeps) {}

  async read<T>(source: string, modules: string[] | undefined, fn: (c: PoolClient) => Promise<T>): Promise<T | null> {
    try {
      if (this.deps.read) return (await this.deps.read(this.tenantId, source, modules, fn)) as T;
      return await withTenants([this.tenantId], fn, modules ? { modules } : undefined);
    } catch (e) {
      // The message can carry SQL detail: log it, never return it.
      logger.warn(`account summary source "${source}" failed for ${this.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
      if (!this.unavailable.includes(source)) this.unavailable.push(source);
      return null;
    }
  }
  mark(source: string): void {
    if (!this.unavailable.includes(source)) this.unavailable.push(source);
  }
}

const isoOf = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function waitingOf(rows: BallRow[]): SnapshotWaiting {
  const visible = rows.filter((r) => r.clientVisible);
  let oldest: string | null = null;
  for (const r of visible) {
    const s = isoOf(r.since);
    if (s !== null && (oldest === null || s < oldest)) oldest = s;
  }
  return { count: visible.length, oldestSince: oldest };
}

type Row = Record<string, unknown>;

/** Build the snapshot of one client's month. `clientName` is the client's own name, read by the caller. */
export async function buildAccountSummarySnapshot(
  input: { tenantId: string; clientId: string; clientName: string; period: SummaryPeriod },
  deps: AccountSummaryDeps = {},
): Promise<AccountSummarySnapshot> {
  const { tenantId, clientId, clientName, period } = input;
  const now = deps.now ?? new Date();
  const reads = new SummaryReads(tenantId, deps);
  const scope = clientWideScope(clientId);
  const values = scopeValues(scope);
  const reach: Reach = { kind: "portal", clientIds: scope.clientIds, scopeParams: values };
  const range = [period.startAt.toISOString(), period.endExclusive.toISOString()];

  // ── projects: PV7-02's portal read, as the client-wide contact would get it ──
  const projectMap = await reads.read("projectHealth", undefined, (c) => loadProjectHealth(c, reach));
  const projects: SnapshotProject[] | null = projectMap === null ? null : (projectMap.get(clientId) ?? []).map((p) => ({
    projectId: p.projectId, name: p.name, status: p.status,
    milestones: p.milestones, deliverables: p.deliverables,
    nextMilestone: p.nextMilestone ? { name: p.nextMilestone.name, dueDate: p.nextMilestone.dueDate } : null,
  }));

  // ── the ball, reduced to a count and the oldest instant (the items' labels and contexts are not copied) ──
  // The social wall is declared, as the portal controller declares it (a post review sits behind it).
  const ball = await reads.read("ball", ["social"], (c) => loadClientBall(c, scope.clientIds, { portal: { params: values } }));
  const waiting = ball === null ? null : {
    onClient: waitingOf(ball.get(clientId)?.needsClient ?? []),
    onUs: waitingOf(ball.get(clientId)?.needsUs ?? []),
  };

  // ── turnaround on both sides: the 90 days ENDING at the end of the month ──
  const turnaroundMap = await reads.read("turnaround", ["social"], (c) => loadTurnaround(c, reach, { asOf: period.endExclusive }));
  const t = turnaroundMap?.get(clientId);
  const turnaround: AccountSummarySnapshot["turnaround"] = turnaroundMap === null ? null : {
    windowDays: TURNAROUND_WINDOW_DAYS,
    windowEnd: period.periodEnd,
    client: t ? { medianDays: t.client.medianDays, n: t.client.n, withheld: t.client.withheld } : { medianDays: null, n: 0, withheld: true },
    ours: t ? { medianDays: t.ours.medianDays, n: t.ours.n, withheld: t.ours.withheld } : { medianDays: null, n: 0, withheld: true },
  };

  // ── milestones completed in the month ──
  const knownSinceAt = await (deps.knownSince ? deps.knownSince() : loadOnTimeKnownSince(tenantId)).catch(() => null);
  const S = scopeAt(2);
  const milestones = await reads.read("milestones", undefined, async (c) => {
    const r = await c.query<Row>(
      `SELECT m.id, m.name, m.project_id AS "projectId", p.name AS "projectName",
              to_char(m.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "completedOn", count(*) OVER ()::int AS total
         FROM pm_milestones m
         JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
        WHERE p.client_id = ANY($1::uuid[]) AND NOT p.is_internal AND ${projectInPortalScope("p", S)}
          AND ${milestoneClientVisible("m")} AND m.status = 'done'
          AND m.completed_at >= $5::timestamptz AND m.completed_at < $6::timestamptz
        ORDER BY m.completed_at ASC, m.id ASC
        LIMIT ${SUMMARY_ITEM_CAP}`,
      [reach.clientIds, ...values, ...range],
    );
    return r.rows;
  });
  const knownSince = knownSinceAt ? knownSinceAt.slice(0, 10) : null;
  const completedMilestones: AccountSummarySnapshot["completed"]["milestones"] = milestones === null ? null : {
    count: milestones[0] ? Number(milestones[0].total) : 0,
    knownSince,
    // The month is fully covered only when completion dates were already being recorded on its first day.
    wholeMonthKnown: knownSinceAt === null ? null : knownSinceAt <= period.startAt.toISOString(),
    items: milestones.map((r) => ({
      projectId: r.projectId as string, projectName: r.projectName as string, name: r.name as string, completedOn: r.completedOn as string,
    })),
  };

  // ── deliverables delivered in the month (best available: the status last changed in the month) ──
  const deliverables = await reads.read("deliverables", undefined, async (c) => {
    const r = await c.query<Row>(
      `SELECT d.id, d.name, d.project_id AS "projectId", p.name AS "projectName", d.status,
              to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "on", count(*) OVER ()::int AS total
         FROM deliverables d
         JOIN projects p ON p.id = d.project_id AND p.tenant_id = d.tenant_id
        WHERE p.client_id = ANY($1::uuid[]) AND NOT p.is_internal AND ${projectInPortalScope("p", S)}
          AND ${deliverableClientVisible("d")} AND d.status = ANY($5::text[])
          AND d.updated_at >= $6::timestamptz AND d.updated_at < $7::timestamptz
        ORDER BY d.updated_at ASC, d.id ASC
        LIMIT ${SUMMARY_ITEM_CAP}`,
      [reach.clientIds, ...values, DELIVERED_STATUSES, ...range],
    );
    return r.rows;
  });
  const completedDeliverables: AccountSummarySnapshot["completed"]["deliverables"] = deliverables === null ? null : {
    count: deliverables[0] ? Number(deliverables[0].total) : 0,
    basis: "status_changed_in_month",
    items: deliverables.map((r) => ({
      projectId: r.projectId as string, projectName: r.projectName as string, name: r.name as string,
      status: r.status as string, on: r.on as string,
    })),
  };

  // ── the Services & results numbers, frozen, minus money ──
  let results: AccountSummarySnapshot["results"] = null;
  try {
    const composed = await (deps.compose ?? composeBusinessResults)(tenantId, clientId, { now });
    results = composed.visible ? stripMoneyKpis(composed) : null;
  } catch (e) {
    logger.warn(`account summary results failed for ${tenantId}: ${e instanceof Error ? e.message : String(e)}`);
    reads.mark("results");
  }

  // ── the client reports published in the month (the client-wide contact's own reach: titles and periods only) ──
  const reportRows = await reads.read("reports", undefined, async (c) => {
    const r = await c.query<Row>(
      `SELECT cr.id, cr.title, cr.source, to_char(cr.period_start, 'YYYY-MM-DD') AS "periodStart",
              to_char(cr.period_end, 'YYYY-MM-DD') AS "periodEnd",
              to_char(cr.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "publishedOn"
         FROM client_reports cr
        WHERE ${clientReportInPortalScope("cr", scopeAt(1))}
          AND cr.published_at >= $4::timestamptz AND cr.published_at < $5::timestamptz
        ORDER BY cr.published_at ASC, cr.id ASC
        LIMIT ${SUMMARY_ITEM_CAP}`,
      [...values, ...range],
    );
    return r.rows;
  });
  const reports: SnapshotReport[] | null = reportRows === null ? null : reportRows.map((r) => ({
    id: r.id as string, title: r.title as string, source: r.source as string,
    periodStart: r.periodStart as string, periodEnd: r.periodEnd as string, publishedOn: r.publishedOn as string,
  }));

  return {
    version: 1,
    clientId, clientName,
    period: period.period, periodStart: period.periodStart, periodEnd: period.periodEnd,
    generatedAt: now.toISOString(),
    projects, waiting,
    completed: { milestones: completedMilestones, deliverables: completedDeliverables },
    turnaround, results, reports,
    unavailable: [...reads.unavailable],
  };
}
