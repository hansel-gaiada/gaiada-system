// PV7-02 — client health: the staff board, the one-client read, and the reads the portal's own view shares (BFF §54).
//
// ── THE SHAPE OF THE COST ────────────────────────────────────────────────────────────────────────────
// The board is one row per client for a whole company (71 on the live estate). It is built from ONE read per source,
// each a set read over `clientIds[]`, so the number of queries is fixed whatever the client count
// (`client-health.db.test.ts` pins it). The hub overview, by contrast, costs seven queries PER client.
//
// ── EACH SOURCE READS ON ITS OWN ─────────────────────────────────────────────────────────────────────
// A source is a transaction of its own, declaring exactly the module scopes its tables sit behind. Two reasons:
//   * a failed query aborts the whole Postgres transaction, so one failing source in a shared transaction would take
//     every other source down with it;
//   * a table behind a module wall (`social`, `monitoring`, `search`, `webdev`) reads ZERO ROWS, with no error, in a
//     transaction that did not declare its module (CLAUDE.md, "the three walls"). Declaring the scope per source keeps a
//     forgotten scope from borrowing a neighbour's.
// A source that throws is named in `unavailable[]` and every signal it feeds is `null`. NEVER 0: an empty list is a claim.
// (Precedent: centre/results/compose.ts.)
//
// ── NULL MEANS "NO ANSWER" ───────────────────────────────────────────────────────────────────────────
// A signal is `null` when its source failed, or when the module behind it is off for the company (not applicable: the
// source is then NOT listed as unavailable). The rules (client-health-rules.ts) treat a null as nothing and turn a row
// that would say on track into `unknown` when any source is unavailable.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { FINISHED_PROJECT_STATUSES } from "../../core/project-status";
import {
  changeRequestClientVisible, contractClientVisible, deliverableClientVisible, gateClientVisible, invoiceClientVisible,
  invoicePaymentClientVisible, milestoneClientVisible, postReviewClientVisible, projectClientVisible, projectInPortalScope,
  runInPortalScope, scopeAt, staffClientVisible, staffConversationMessageClientVisible, staffGateClientVisible,
  staffInvoicePaymentClientVisible, conversationThreadInPortalScope, wideClientOnly, wideOrOwnProject,
} from "../../core/portal-visibility";
import { enabledModuleKeys } from "../registry";
import { UPTIME_RATIO_SQL } from "../monitoring/monitoring.controller";
import { loadClientBall } from "./client-ball";
import {
  evaluateClientHealth,
  type Aged, type DueAged, type HealthReason, type HealthSource, type HealthState,
} from "./client-health-rules";

const logger = new Logger("ClientHealth");

export type { Aged, DueAged, HealthReason, HealthSource, HealthState };

// ── Payload types (BFF §54.2) ────────────────────────────────────────────────────────────────────────

export interface ClientSignals {
  waitingOnUs: Aged | null;
  waitingOnClient: Aged | null;
  lateDeliverables: DueAged | null;
  lateMilestones: DueAged | null;
  openChangeRequests: number | null;
  conversationsAwaitingReply: number | null;
  overdueInvoices: DueAged | null;
  site: { openIncidents: number; oldestOpenSince: string | null; uptime30d: number | null } | null;
  /** PV7-01 will supply delivery on time from the client-grain overview. Always null until it does: see `deliveryOnTimeFor`. */
  deliveryOnTime: null;
  activeProjects: number | null;
  activeServices: number | null;
}

export interface ClientHealthRow {
  clientId: string;
  name: string;
  status: string;
  ownerUserId: string | null;
  ownerName: string | null;
  state: HealthState;
  reasons: HealthReason[];
  signals: ClientSignals;
}

export interface ProjectHealth {
  projectId: string;
  name: string;
  status: string;
  clientVisible: boolean;
  milestones: MilestoneCounts;
  deliverables: DeliverableCounts;
  nextMilestone: { id: string; name: string; dueDate: string } | null;
}
export interface MilestoneCounts { total: number; done: number; upcoming: number; late: number; undated: number }
export interface DeliverableCounts { total: number; delivered: number; late: number }

export type TurnaroundKind =
  | "client_gate" | "contract_signed" | "post_review"
  | "change_request_triage" | "payment_confirmed" | "conversation_reply";
export interface TurnaroundPart { kind: TurnaroundKind; medianDays: number | null; n: number; withheld: boolean; clientVisible: boolean }
export interface Turnaround { medianDays: number | null; n: number; withheld: boolean; parts: TurnaroundPart[] }
export interface TurnaroundPair { windowDays: 90; client: Turnaround; ours: Turnaround }

export interface ClientHealthBoard {
  asOf: string;
  onTimeKnownSince: string | null;
  clients: ClientHealthRow[];
  unavailable: HealthSource[];
}
export interface ClientHealthDetail extends ClientHealthRow {
  asOf: string;
  onTimeKnownSince: string | null;
  unavailable: HealthSource[];
  projects: ProjectHealth[] | null;
  turnaround: TurnaroundPair | null;
}

/** A median over fewer samples than this is withheld (`medianDays: null`). */
export const TURNAROUND_MIN_SAMPLES = 3;
export const TURNAROUND_WINDOW_DAYS = 90;

export const CLIENT_SIDE_PARTS: readonly TurnaroundKind[] = ["client_gate", "contract_signed", "post_review"];
export const OUR_SIDE_PARTS: readonly TurnaroundKind[] = ["change_request_triage", "payment_confirmed", "conversation_reply"];

// ── Injection points (tests) ─────────────────────────────────────────────────────────────────────────

export type SourceReader = (
  tenantId: string, source: HealthSource, modules: string[] | undefined, fn: (c: PoolClient) => Promise<unknown>,
) => Promise<unknown>;

export interface HealthDeps {
  now?: Date;
  /** Override the enabled-module lookup. */
  enabled?: ReadonlySet<string>;
  /** Override how a source opens its transaction: a test throws for one source to prove `unavailable`, or drops `modules`
   *  to prove the module scope is load-bearing. */
  read?: SourceReader;
  /** Called with the SQL text of every query a source issues (the query-count pin). */
  onQuery?: (sql: string) => void;
}

/** A client wrapper that reports every query's text before forwarding it, so a test can count them. */
function counted(c: PoolClient, onQuery?: (sql: string) => void): PoolClient {
  if (!onQuery) return c;
  return new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          const first = args[0];
          onQuery(typeof first === "string" ? first : String((first as { text?: string } | undefined)?.text ?? ""));
          return (target.query as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Runs sources one after another (never in parallel: nine concurrent transactions per request would drain the pool),
 *  each in its own transaction, and remembers which ones failed. */
export class HealthReads {
  readonly unavailable = new Set<HealthSource>();
  constructor(readonly tenantId: string, private readonly deps: HealthDeps = {}) {}

  async read<T>(source: HealthSource, modules: string[] | undefined, fn: (c: PoolClient) => Promise<T>): Promise<T | null> {
    const wrapped = (c: PoolClient) => fn(counted(c, this.deps.onQuery));
    try {
      if (this.deps.read) return (await this.deps.read(this.tenantId, source, modules, wrapped)) as T;
      return await withTenants([this.tenantId], wrapped, modules ? { modules } : undefined);
    } catch (e) {
      // The message can carry SQL detail: log it, never return it.
      logger.warn(`health source "${source}" failed for ${this.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
      this.unavailable.add(source);
      return null;
    }
  }

  mark(source: HealthSource): void { this.unavailable.add(source); }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────────

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number => Number(v ?? 0);
type Row = Record<string, unknown>;

function byClient<T>(rows: T[] | null, key: (r: T) => string): Map<string, T> | null {
  if (!rows) return null;
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return m;
}

function minInstant(values: unknown[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    const s = iso(v);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

/** PV7-01 SEAM. Delivery on time this month comes from the client-grain overview that PV7-01 adds. Until that is on main
 *  (or with the reports module off) every client's answer is `null`, which the payload carries as `deliveryOnTime: null`.
 *  When PV7-01 lands, only this function changes; the payload type already has the field. */
export async function deliveryOnTimeFor(_tenantId: string, _clientIds: string[]): Promise<null> {
  return null;
}

let ledgerAppliedAt: string | null = null;

/** The instant from which "done on time" can be judged: `pm_milestones.completed_at` exists from this migration on and
 *  nothing before it was back-filled (BFF §54.4). The migration's applied time in `schema_migrations`; if the app role
 *  cannot read the ledger, the earliest `completed_at` in the company; else null. Never throws. */
export async function loadOnTimeKnownSince(tenantId: string): Promise<string | null> {
  if (ledgerAppliedAt) return ledgerAppliedAt;
  try {
    const r = await withGlobal((c) =>
      c.query<{ applied_at: Date }>(
        `SELECT applied_at FROM schema_migrations WHERE name = '202610151710_pm_milestones_completed_at.sql'`,
      ),
    );
    const at = iso(r.rows[0]?.applied_at);
    if (at) { ledgerAppliedAt = at; return at; }
  } catch (e) {
    logger.warn(`onTimeKnownSince: the migration ledger is not readable (${e instanceof Error ? e.message : String(e)}); falling back`);
  }
  try {
    const r = await withTenants([tenantId], (c) => c.query<{ at: Date | null }>(`SELECT min(completed_at) AS at FROM pm_milestones`));
    return iso(r.rows[0]?.at);
  } catch {
    return null;
  }
}

// ── The sources ──────────────────────────────────────────────────────────────────────────────────────

interface ClientRow { id: string; name: string; status: string; ownerUserId: string | null; ownerName: string | null }

/** Every signal for `clients`, one set read per source. Returns the signals by client id; a failed source's signals are null. */
async function loadSignals(
  reads: HealthReads, clients: ClientRow[], enabled: ReadonlySet<string> | null,
): Promise<Map<string, ClientSignals>> {
  const ids = clients.map((c) => c.id);
  const finished = [...FINISHED_PROJECT_STATUSES];

  const projects = byClient(await reads.read("projects", undefined, async (c) =>
    (await c.query<Row>(
      `SELECT p.client_id AS "clientId", count(*) FILTER (WHERE NOT (p.status = ANY($2::text[])))::int AS active
         FROM projects p
        WHERE p.client_id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND NOT p.is_internal
        GROUP BY p.client_id`,
      [ids, finished],
    )).rows), (r) => r.clientId as string);

  const milestones = byClient(await reads.read("milestones", undefined, async (c) =>
    (await c.query<Row>(
      // Late = open and past due, on an ACTIVE, non-internal project. `done` is the set computeMilestoneHitRate counts.
      `SELECT p.client_id AS "clientId", count(*)::int AS late, to_char(min(m.due_date), 'YYYY-MM-DD') AS "oldestDue"
         FROM pm_milestones m JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
        WHERE p.client_id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND NOT p.is_internal AND NOT (p.status = ANY($2::text[]))
          AND ${milestoneClientVisible("m")} AND m.status <> 'done' AND m.due_date < current_date
        GROUP BY p.client_id`,
      [ids, finished],
    )).rows), (r) => r.clientId as string);

  const deliverables = byClient(await reads.read("deliverables", undefined, async (c) =>
    (await c.query<Row>(
      // A deliverable reaches its client through its project (client_id on the row is nullable), as the portal reads it.
      `SELECT COALESCE(p.client_id, d.client_id) AS "clientId", count(*)::int AS late, to_char(min(d.due_date), 'YYYY-MM-DD') AS "oldestDue"
         FROM deliverables d LEFT JOIN projects p ON p.id = d.project_id AND p.tenant_id = d.tenant_id
        WHERE COALESCE(p.client_id, d.client_id) = ANY($1::uuid[])
          AND (p.id IS NULL OR (p.deleted_at IS NULL AND NOT p.is_internal AND NOT (p.status = ANY($2::text[]))))
          AND ${deliverableClientVisible("d")}
          AND d.due_date < current_date AND d.status NOT IN ('delivered', 'approved', 'done')
        GROUP BY COALESCE(p.client_id, d.client_id)`,
      [ids, finished],
    )).rows), (r) => r.clientId as string);

  const requests = byClient(await reads.read("requests", undefined, async (c) =>
    (await c.query<Row>(
      `SELECT w.client_id AS "clientId", count(*)::int AS n
         FROM webdev_change_requests w
        WHERE w.client_id = ANY($1::uuid[]) AND ${changeRequestClientVisible("w")} AND w.status IN ('new', 'triaged', 'in_progress')
        GROUP BY w.client_id`,
      [ids],
    )).rows), (r) => r.clientId as string);

  const invoices = byClient(await reads.read("invoices", undefined, async (c) =>
    (await c.query<Row>(
      // Kept in step with `clientMoney` (clients.controller.ts): ISSUED (`sent`) and past the due date, a legacy invoice with
      // no due date falling back to its period end (PV5-04, decision 10).
      `SELECT i.client_id AS "clientId", count(*)::int AS n, to_char(min(COALESCE(i.due_date, i.period_end)), 'YYYY-MM-DD') AS "oldestDue"
         FROM invoices i
        WHERE i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status = 'sent'
          AND COALESCE(i.due_date, i.period_end) < current_date
        GROUP BY i.client_id`,
      [ids],
    )).rows), (r) => r.clientId as string);

  // The ball: ONE source. The social wall is declared here (see client-ball.ts: without it the post reviews read zero rows).
  const ball = await reads.read("ball", ["social"], (c) => loadClientBall(c, ids));

  // The site: monitors by client_id, behind the monitoring wall. Not applicable when the module is off.
  let incidents: Map<string, Row> | null = null;
  let uptime: Map<string, Row> | null = null;
  let siteApplies = false;
  if (enabled?.has("monitoring")) {
    siteApplies = true;
    const read = await reads.read("site", ["monitoring"], async (c) => {
      const inc = await c.query<Row>(
        `SELECT m.client_id AS "clientId", count(*)::int AS n, min(i.opened_at) AS "oldestOpenSince"
           FROM monitor_incidents i JOIN monitors m ON m.id = i.monitor_id AND m.tenant_id = i.tenant_id
          WHERE m.client_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.enabled AND i.closed_at IS NULL
          GROUP BY m.client_id`,
        [ids],
      );
      const up = await c.query<Row>(
        // The monitoring console's own ratio text (UPTIME_RATIO_SQL), as the client-facing website card reuses it.
        `SELECT m.client_id AS "clientId", ${UPTIME_RATIO_SQL} AS ratio
           FROM monitor_results r JOIN monitors m ON m.id = r.monitor_id AND m.tenant_id = r.tenant_id
          WHERE m.client_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.enabled
            AND r.checked_at >= now() - interval '30 days'
          GROUP BY m.client_id`,
        [ids],
      );
      return { inc: inc.rows, up: up.rows };
    });
    incidents = read ? byClient(read.inc, (r) => r.clientId as string) : null;
    uptime = read ? byClient(read.up, (r) => r.clientId as string) : null;
  }

  // Active services: social engagements, search properties, websites. Only the modules the company has on are read.
  let services: Map<string, number> | null = new Map();
  if (enabled === null) {
    services = null; // the module lookup failed ("modules" is already unavailable)
  } else {
    const mods = ["social", "search", "webdev"].filter((m) => enabled.has(m));
    if (mods.length > 0) {
      const got = await reads.read("services", mods, async (c) => {
        const total = new Map<string, number>();
        const add = (rows: Row[]) => { for (const r of rows) total.set(r.clientId as string, (total.get(r.clientId as string) ?? 0) + num(r.n)); };
        if (enabled.has("social")) {
          add((await c.query<Row>(`SELECT client_id AS "clientId", count(*)::int AS n FROM social_engagements
                                    WHERE client_id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL GROUP BY client_id`, [ids])).rows);
        }
        if (enabled.has("search")) {
          add((await c.query<Row>(`SELECT client_id AS "clientId", count(*)::int AS n FROM search_properties
                                    WHERE client_id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL GROUP BY client_id`, [ids])).rows);
        }
        if (enabled.has("webdev")) {
          add((await c.query<Row>(`SELECT client_id AS "clientId", count(*)::int AS n FROM webdev_sites
                                    WHERE client_id = ANY($1::uuid[]) AND deleted_at IS NULL GROUP BY client_id`, [ids])).rows);
        }
        return total;
      });
      services = got;
    }
  }

  const out = new Map<string, ClientSignals>();
  for (const cl of clients) {
    const id = cl.id;
    const items = ball?.get(id);
    const lateM = milestones === null ? null : milestones.get(id);
    const lateD = deliverables === null ? null : deliverables.get(id);
    const inv = invoices === null ? null : invoices.get(id);
    const incRow = incidents?.get(id);
    const upRow = uptime?.get(id);
    out.set(id, {
      waitingOnUs: ball === null ? null : { count: items?.needsUs.length ?? 0, oldestSince: minInstant((items?.needsUs ?? []).map((i) => i.since)) },
      waitingOnClient: ball === null ? null : { count: items?.needsClient.length ?? 0, oldestSince: minInstant((items?.needsClient ?? []).map((i) => i.since)) },
      lateDeliverables: deliverables === null ? null : { count: num(lateD?.late), oldestDue: (lateD?.oldestDue as string | undefined) ?? null },
      lateMilestones: milestones === null ? null : { count: num(lateM?.late), oldestDue: (lateM?.oldestDue as string | undefined) ?? null },
      openChangeRequests: requests === null ? null : num(requests.get(id)?.n),
      conversationsAwaitingReply: ball === null ? null : (items?.needsUs ?? []).filter((i) => i.kind === "conversation").length,
      overdueInvoices: invoices === null ? null : { count: num(inv?.n), oldestDue: (inv?.oldestDue as string | undefined) ?? null },
      site: !siteApplies || incidents === null || uptime === null ? null : {
        openIncidents: num(incRow?.n),
        oldestOpenSince: iso(incRow?.oldestOpenSince),
        // A percent with two decimals, as the website card prints it; null for a window with no measured checks.
        uptime30d: upRow?.ratio === null || upRow?.ratio === undefined ? null : Math.round(Number(upRow.ratio) * 10000) / 100,
      },
      deliveryOnTime: null,
      activeProjects: projects === null ? null : num(projects.get(id)?.active),
      activeServices: services === null ? null : services.get(id) ?? 0,
    });
  }
  return out;
}

async function rowsFor(
  tenantId: string, clients: ClientRow[], deps: HealthDeps,
): Promise<{ rows: ClientHealthRow[]; reads: HealthReads; now: Date; enabled: ReadonlySet<string> | null }> {
  const reads = new HealthReads(tenantId, deps);
  const now = deps.now ?? new Date();
  let enabled: ReadonlySet<string> | null = null;
  if (deps.enabled) enabled = deps.enabled;
  else {
    try { enabled = new Set(await enabledModuleKeys(tenantId)); }
    catch (e) {
      logger.warn(`health: the enabled-module lookup failed for ${tenantId}: ${e instanceof Error ? e.message : String(e)}`);
      reads.mark("modules");
    }
  }
  const signals = await loadSignals(reads, clients, enabled);
  await deliveryOnTimeFor(tenantId, clients.map((c) => c.id));
  const unavailable = [...reads.unavailable];
  const rows = clients.map((cl): ClientHealthRow => {
    const s = signals.get(cl.id)!;
    const verdict = evaluateClientHealth(
      {
        waitingOnUs: s.waitingOnUs, waitingOnClient: s.waitingOnClient, lateDeliverables: s.lateDeliverables,
        lateMilestones: s.lateMilestones, overdueInvoices: s.overdueInvoices,
        site: s.site ? { openIncidents: s.site.openIncidents, oldestOpenSince: s.site.oldestOpenSince } : null,
        activeProjects: s.activeProjects, activeServices: s.activeServices,
      },
      unavailable, now,
    );
    return {
      clientId: cl.id, name: cl.name, status: cl.status, ownerUserId: cl.ownerUserId, ownerName: cl.ownerName,
      state: verdict.state, reasons: verdict.reasons, signals: s,
    };
  });
  return { rows, reads, now, enabled };
}

const CLIENT_SELECT = `SELECT cl.id, cl.name, cl.status, cl.owner_user_id AS "ownerUserId", ou.name AS "ownerName"
                         FROM clients cl LEFT JOIN users ou ON ou.id = cl.owner_user_id`;

/** The staff board: every client that is not soft-deleted, not the internal sentinel and not archived. */
export async function loadClientHealthBoard(tenantId: string, deps: HealthDeps = {}): Promise<ClientHealthBoard> {
  const clients = await withTenants([tenantId], (c) =>
    counted(c, deps.onQuery).query<ClientRow>(
      `${CLIENT_SELECT} WHERE cl.deleted_at IS NULL AND NOT cl.is_internal AND cl.status <> 'archived' ORDER BY cl.name, cl.id`,
    ),
  );
  const { rows, reads, now } = await rowsFor(tenantId, clients.rows, deps);
  return {
    asOf: now.toISOString(),
    onTimeKnownSince: await loadOnTimeKnownSince(tenantId),
    clients: rows,
    unavailable: [...reads.unavailable],
  };
}

/** One client's health: the board row, per-project health and the 90-day turnaround. Null when the client does not exist
 *  (or is soft-deleted, or the internal sentinel). */
export async function loadClientHealthDetail(tenantId: string, clientId: string, deps: HealthDeps = {}): Promise<ClientHealthDetail | null> {
  const found = await withTenants([tenantId], (c) =>
    counted(c, deps.onQuery).query<ClientRow>(`${CLIENT_SELECT} WHERE cl.id = $1 AND cl.deleted_at IS NULL AND NOT cl.is_internal`, [clientId]),
  );
  if (!found.rows[0]) return null;
  const { rows, reads, now } = await rowsFor(tenantId, [found.rows[0]], deps);
  const reach: Reach = { kind: "staff", clientIds: [clientId] };
  const projects = await reads.read("projectHealth", undefined, (c) => loadProjectHealth(c, reach));
  const turnaround = await reads.read("turnaround", ["social"], (c) => loadTurnaround(c, reach));
  return {
    ...rows[0],
    asOf: now.toISOString(),
    onTimeKnownSince: await loadOnTimeKnownSince(tenantId),
    unavailable: [...reads.unavailable],
    projects: projects ? projects.get(clientId) ?? [] : null,
    turnaround: turnaround ? turnaround.get(clientId) ?? emptyPair() : null,
  };
}

// ── Reads the portal's own view shares (BFF §54.5) ───────────────────────────────────────────────────

/** Who is asking. Staff reach the clients they were handed (authorization is the caller's); a portal caller reaches only
 *  what their scope admits, through portal-visibility.ts. `scopeParams` is `scopeValues(scope)`. */
export type Reach =
  | { kind: "staff"; clientIds: string[] }
  | { kind: "portal"; clientIds: string[]; scopeParams: [string[], string[], string[]] };

const paramsFor = (reach: Reach): unknown[] => (reach.kind === "portal" ? [reach.clientIds, ...reach.scopeParams] : [reach.clientIds]);

/** Per-project health for every client in `reach`, keyed by client id. Four queries, always (even with no project).
 *  A staff reach also reads each project's `clientVisible`; a portal reach is confined to the caller's projects. The
 *  figures are computed ONLY from milestones and deliverables, both of which a client can already see: never tasks. */
export async function loadProjectHealth(c: PoolClient, reach: Reach): Promise<Map<string, ProjectHealth[]>> {
  const portal = reach.kind === "portal";
  const S = scopeAt(2);
  const projects = await c.query<Row>(
    `SELECT p.id AS "projectId", p.client_id AS "clientId", p.name, p.status,
            ${staffClientVisible("p", projectClientVisible("p"))} AS "clientVisible"
       FROM projects p
      WHERE p.client_id = ANY($1::uuid[]) AND NOT p.is_internal AND ${portal ? projectInPortalScope("p", S) : projectClientVisible("p")}
      ORDER BY p.name, p.id`,
    paramsFor(reach),
  );
  const projectIds = projects.rows.map((p) => p.projectId as string);

  const milestones = await c.query<Row>(
    `SELECT m.project_id AS "projectId", count(*)::int AS total,
            count(*) FILTER (WHERE m.status = 'done')::int AS done,
            count(*) FILTER (WHERE m.status <> 'done' AND m.due_date >= current_date)::int AS upcoming,
            count(*) FILTER (WHERE m.status <> 'done' AND m.due_date < current_date)::int AS late,
            count(*) FILTER (WHERE m.status <> 'done' AND m.due_date IS NULL)::int AS undated
       FROM pm_milestones m
      WHERE m.project_id = ANY($1::uuid[]) AND ${milestoneClientVisible("m")}
      GROUP BY m.project_id`,
    [projectIds],
  );
  const next = await c.query<Row>(
    `SELECT DISTINCT ON (m.project_id) m.project_id AS "projectId", m.id, m.name, to_char(m.due_date, 'YYYY-MM-DD') AS "dueDate"
       FROM pm_milestones m
      WHERE m.project_id = ANY($1::uuid[]) AND ${milestoneClientVisible("m")} AND m.status <> 'done' AND m.due_date IS NOT NULL
      ORDER BY m.project_id, m.due_date ASC, m.id ASC`,
    [projectIds],
  );
  const deliverables = await c.query<Row>(
    `SELECT d.project_id AS "projectId", count(*)::int AS total,
            count(*) FILTER (WHERE d.status IN ('delivered', 'approved', 'done'))::int AS delivered,
            count(*) FILTER (WHERE d.due_date < current_date AND d.status NOT IN ('delivered', 'approved', 'done'))::int AS late
       FROM deliverables d
      WHERE d.project_id = ANY($1::uuid[]) AND ${deliverableClientVisible("d")}
      GROUP BY d.project_id`,
    [projectIds],
  );
  const m = new Map(milestones.rows.map((r) => [r.projectId as string, r]));
  const n = new Map(next.rows.map((r) => [r.projectId as string, r]));
  const d = new Map(deliverables.rows.map((r) => [r.projectId as string, r]));

  const out = new Map<string, ProjectHealth[]>();
  for (const p of projects.rows) {
    const id = p.projectId as string;
    const mr = m.get(id);
    const dr = d.get(id);
    const nr = n.get(id);
    const health: ProjectHealth = {
      projectId: id, name: p.name as string, status: p.status as string, clientVisible: p.clientVisible === true,
      milestones: { total: num(mr?.total), done: num(mr?.done), upcoming: num(mr?.upcoming), late: num(mr?.late), undated: num(mr?.undated) },
      deliverables: { total: num(dr?.total), delivered: num(dr?.delivered), late: num(dr?.late) },
      nextMilestone: nr ? { id: nr.id as string, name: nr.name as string, dueDate: nr.dueDate as string } : null,
    };
    const list = out.get(p.clientId as string) ?? [];
    list.push(health);
    out.set(p.clientId as string, list);
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function emptyTurnaround(parts: readonly TurnaroundKind[]): Turnaround {
  return {
    medianDays: null, n: 0, withheld: true,
    parts: parts.map((kind) => ({ kind, medianDays: null, n: 0, withheld: true, clientVisible: true })),
  };
}
function emptyPair(): TurnaroundPair {
  return { windowDays: TURNAROUND_WINDOW_DAYS, client: emptyTurnaround(CLIENT_SIDE_PARTS), ours: emptyTurnaround(OUR_SIDE_PARTS) };
}

/** The 90-day turnaround for every client in `reach`, keyed by client id: how long each side takes to answer, as a median
 *  over the samples the client can already see the rows of. ONE query. The transaction must declare `{ modules: ["social"] }`
 *  (post reviews sit behind the social wall). Internal gates are never samples, and a portal reach is confined, per
 *  sample, by the same predicates the portal's own reads use: a sample with no project (and the payment and post-review
 *  samples, which belong to the client rather than a project) reaches client-wide contacts only. */
export async function loadTurnaround(c: PoolClient, reach: Reach): Promise<Map<string, TurnaroundPair>> {
  const portal = reach.kind === "portal";
  const S = scopeAt(2);
  const w = (sql: string) => (portal ? ` AND ${sql}` : "");
  const r = await c.query<Row>(
    `WITH s AS (
       SELECT r.client_id AS client_id, 'client_gate'::text AS part, 'client'::text AS side,
              EXTRACT(EPOCH FROM (g.decided_at - g.created_at)) / 86400.0 AS days, g.decided_at AS answered_at,
              ${staffGateClientVisible("g", "r")} AS vis
         FROM pipeline_gates g JOIN pipeline_runs r ON r.id = g.run_id
        WHERE r.client_id = ANY($1::uuid[]) AND ${gateClientVisible("g")} AND g.status = 'decided' AND g.decided_at IS NOT NULL${
          w(runInPortalScope("r", S))}
       UNION ALL
       SELECT k.client_id, 'contract_signed', 'client',
              EXTRACT(EPOCH FROM (k.signed_at - k.sent_at)) / 86400.0, k.signed_at,
              ${staffClientVisible("k", contractClientVisible("k"))}
         FROM contracts k
        WHERE k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status = 'signed' AND k.sent_at IS NOT NULL AND k.signed_at IS NOT NULL${
          w(`${contractClientVisible("k")} AND ${wideOrOwnProject("k", S)}`)}
       UNION ALL
       SELECT rv.client_id, 'post_review', 'client',
              EXTRACT(EPOCH FROM (rv.decided_at - rv.requested_at)) / 86400.0, rv.decided_at,
              ${staffClientVisible("rv", postReviewClientVisible("rv"))}
         FROM social_post_client_reviews rv
        WHERE rv.client_id = ANY($1::uuid[]) AND rv.decided_at IS NOT NULL AND rv.status IN ('approved', 'changes_requested')${
          w(`${postReviewClientVisible("rv")} AND ${wideClientOnly("rv", S)}`)}
       UNION ALL
       SELECT w.client_id, 'change_request_triage', 'ours',
              EXTRACT(EPOCH FROM (w.triaged_at - w.created_at)) / 86400.0, w.triaged_at,
              ${staffClientVisible("w", changeRequestClientVisible("w"))}
         FROM webdev_change_requests w
        WHERE w.client_id = ANY($1::uuid[]) AND w.deleted_at IS NULL AND w.source = 'portal' AND w.triaged_at IS NOT NULL${
          w(`${changeRequestClientVisible("w")} AND ${wideOrOwnProject("w", S)}`)}
       UNION ALL
       SELECT pp.client_id, 'payment_confirmed', 'ours',
              EXTRACT(EPOCH FROM (pp.confirmed_at - pp.created_at)) / 86400.0, pp.confirmed_at,
              ${staffInvoicePaymentClientVisible("pp", "i")}
         FROM invoice_payments pp LEFT JOIN invoices i ON i.id = pp.invoice_id
        WHERE pp.client_id = ANY($1::uuid[]) AND pp.deleted_at IS NULL AND pp.source = 'client_claim'
          AND pp.status = 'confirmed' AND pp.confirmed_at IS NOT NULL${
          w(`${invoicePaymentClientVisible("pp", "timeline")} AND ${invoiceClientVisible("i")} AND ${wideClientOnly("pp", S)}`)}
       UNION ALL
       -- Our first reply to each TURN the client started: a client message whose previous live message was not the client's.
       SELECT t.client_id, 'conversation_reply', 'ours',
              EXTRACT(EPOCH FROM (nxt.at - m.created_at)) / 86400.0, nxt.at,
              ${staffConversationMessageClientVisible("m", "t")}
         FROM conversation_messages m
         JOIN conversation_threads t ON t.id = m.thread_id AND t.tenant_id = m.tenant_id
         CROSS JOIN LATERAL (
           SELECT min(sm.created_at) AS at FROM conversation_messages sm
            WHERE sm.thread_id = m.thread_id AND sm.author_side = 'staff' AND sm.retracted_at IS NULL AND sm.created_at > m.created_at) nxt
        WHERE t.client_id = ANY($1::uuid[]) AND m.author_side = 'client' AND m.retracted_at IS NULL AND nxt.at IS NOT NULL
          AND COALESCE((SELECT pm.author_side FROM conversation_messages pm
                         WHERE pm.thread_id = m.thread_id AND pm.retracted_at IS NULL
                           AND (pm.created_at, pm.id) < (m.created_at, m.id)
                         ORDER BY pm.created_at DESC, pm.id DESC LIMIT 1), 'staff') <> 'client'${
          w(conversationThreadInPortalScope("t", S))}
     )
     SELECT client_id AS "clientId", side, CASE WHEN GROUPING(part) = 1 THEN NULL ELSE part END AS part,
            count(*)::int AS n, bool_and(vis) AS vis,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days) AS median
       FROM s
      WHERE days >= 0 AND answered_at >= now() - interval '${TURNAROUND_WINDOW_DAYS} days'
      GROUP BY GROUPING SETS ((client_id, side, part), (client_id, side))`,
    paramsFor(reach),
  );

  const agg = (rows: Row[], parts: readonly TurnaroundKind[], side: string): Turnaround => {
    const mine = rows.filter((x) => x.side === side);
    const pooled = mine.find((x) => x.part === null);
    const n = num(pooled?.n);
    const withheld = n < TURNAROUND_MIN_SAMPLES;
    return {
      medianDays: withheld || pooled?.median === null || pooled?.median === undefined ? null : round1(Number(pooled.median)),
      n, withheld,
      parts: parts.map((kind) => {
        const row = mine.find((x) => x.part === kind);
        const pn = num(row?.n);
        const pw = pn < TURNAROUND_MIN_SAMPLES;
        return {
          kind, n: pn, withheld: pw,
          medianDays: pw || row?.median === null || row?.median === undefined ? null : round1(Number(row.median)),
          clientVisible: row ? row.vis === true : true,
        };
      }),
    };
  };

  const byClientRows = new Map<string, Row[]>();
  for (const row of r.rows) {
    const list = byClientRows.get(row.clientId as string) ?? [];
    list.push(row);
    byClientRows.set(row.clientId as string, list);
  }
  const out = new Map<string, TurnaroundPair>();
  for (const id of reach.clientIds) {
    const rows = byClientRows.get(id) ?? [];
    out.set(id, { windowDays: TURNAROUND_WINDOW_DAYS, client: agg(rows, CLIENT_SIDE_PARTS, "client"), ours: agg(rows, OUR_SIDE_PARTS, "ours") });
  }
  return out;
}
