// The client health BOARD (PV7-05): the pure part. Rows, the worst-first order, the filters, and the short words for a
// reason. Client-safe (no I/O, no `server-only`): the reader is `getClientHealthBoard` in `clientHub.ts`, the page is
// `app/(app)/clients/health/page.tsx`, and the same `healthRank` / `healthBoardCells` feed the Clients list's Health
// column.
//
// ── NULL IS "NO ANSWER" ─────────────────────────────────────────────────────────────────────────────
// A signal that is `null` (its source failed, or does not apply to this company) is drawn as `—`, never as `0`. The board
// names the sources that could not be read in a banner (`unavailableSentence`).
import type { Column } from "@/components/data/DataTable";
import {
  STATE_LABEL, SOURCE_LABEL, onTimePercent,
  type Aged, type ClientHealthRow, type DueAged, type HealthReason, type HealthReasonCode, type HealthSource, type HealthState,
} from "./clientHealth";

const DAY_MS = 86_400_000;

/** Worst first: what needs a person soonest. `unknown` sits above `on_track` on purpose: a client we could not judge is
 *  not one we can call fine. `quiet` (no active work) is last. */
export const STATE_ORDER: readonly HealthState[] = ["off_track", "at_risk", "unknown", "on_track", "quiet"];

export const healthRank = (s: HealthState): number => {
  const i = STATE_ORDER.indexOf(s);
  return i < 0 ? STATE_ORDER.length : i;
};

/** Whole days between an instant and `asOf`; 0 for a future or unparseable value, `null` for nothing. */
export function ageInDays(since: string | null | undefined, asOf: string): number | null {
  if (!since) return null;
  const from = Date.parse(since);
  const to = Date.parse(asOf);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/** The short words for a reason, for a table cell. Every `HealthReasonCode` has one (the test checks). The long sentence
 *  with counts and dates stays on the client's own page (`describeReason`). */
export const SHORT_REASON: Record<HealthReasonCode, string> = {
  waiting_on_us_7d: "Waiting on us 7+ days",
  waiting_on_us_14d: "Waiting on us 14+ days",
  waiting_on_client_14d: "Waiting on client 14+ days",
  late_work: "Late work",
  late_work_14d: "Work 14+ days late",
  invoice_overdue: "Invoice overdue",
  invoice_overdue_30d: "Invoice 30+ days overdue",
  site_incident_open: "Site incident open",
  site_incident_open_24h: "Site down 24+ hours",
  no_active_work: "No active work",
  source_unavailable: "Could not be judged",
};

export const shortReasons = (reasons: HealthReason[]): string => reasons.map((r) => SHORT_REASON[r.code]).join(" · ");

/** "3 · oldest 9 days": a count and the age of its oldest item. `—` for no answer, `None` for a real zero. */
export function agedCell(a: Aged | null, asOf: string): string {
  if (a === null) return "—";
  if (a.count === 0) return "None";
  const d = ageInDays(a.oldestSince, asOf);
  return d === null ? String(a.count) : `${a.count} · oldest ${d} ${d === 1 ? "day" : "days"}`;
}

/** The same for a date-based family (late work, overdue invoices): the oldest DUE date, so its age is the lateness. */
export function dueCell(d: DueAged | null, asOf: string): string {
  if (d === null) return "—";
  if (d.count === 0) return "None";
  const days = ageInDays(d.oldestDue, asOf);
  return days === null ? String(d.count) : `${d.count} · ${days} ${days === 1 ? "day" : "days"} late`;
}

/** Late deliverables and late milestones together: the board's one "Late work" cell. `null` only when BOTH sources failed. */
export function lateWorkCell(row: ClientHealthRow, asOf: string): string {
  const { lateDeliverables: d, lateMilestones: m } = row.signals;
  if (d === null && m === null) return "—";
  const parts: string[] = [];
  const count = (d?.count ?? 0) + (m?.count ?? 0);
  // One of the two reads failed and the other found nothing: that is no answer, not "None".
  if (count === 0) return d === null || m === null ? "—" : "None";
  const oldest = [d?.count ? d.oldestDue : null, m?.count ? m.oldestDue : null].filter((x): x is string => !!x).sort()[0] ?? null;
  const days = ageInDays(oldest, asOf);
  parts.push(`${count} (${d?.count ?? 0} deliverable${(d?.count ?? 0) === 1 ? "" : "s"}, ${m?.count ?? 0} milestone${(m?.count ?? 0) === 1 ? "" : "s"})`);
  if (days !== null) parts.push(`${days} ${days === 1 ? "day" : "days"} late`);
  return parts.join(" · ");
}

export function siteCell(row: ClientHealthRow): string {
  const s = row.signals.site;
  if (s === null) return "—";
  const incidents = s.openIncidents === 0 ? "No incidents" : `${s.openIncidents} open ${s.openIncidents === 1 ? "incident" : "incidents"}`;
  return s.uptime30d === null ? incidents : `${incidents} · ${s.uptime30d}% up (30 days)`;
}

/** One board row as the plain record the DataTable takes (no render functions). The `*Sort` fields are what the sortable
 *  columns order by (`Column.sortBy`); `healthRank` makes "Health" sort worst first, not alphabetically. */
export function healthBoardCells(row: ClientHealthRow, asOf: string): Record<string, unknown> {
  const s = row.signals;
  return {
    id: row.clientId,
    name: row.name,
    owner: row.ownerName ?? "—",
    health: row.state,
    healthSort: String(healthRank(row.state)),
    why: shortReasons(row.reasons) || "—",
    waitingOnUs: agedCell(s.waitingOnUs, asOf),
    waitingOnUsSort: s.waitingOnUs?.count ?? -1,
    waitingOnClient: agedCell(s.waitingOnClient, asOf),
    waitingOnClientSort: s.waitingOnClient?.count ?? -1,
    lateWork: lateWorkCell(row, asOf),
    lateWorkSort: s.lateDeliverables === null && s.lateMilestones === null ? -1 : (s.lateDeliverables?.count ?? 0) + (s.lateMilestones?.count ?? 0),
    openRequests: s.openChangeRequests,
    unanswered: s.conversationsAwaitingReply,
    overdueInvoices: dueCell(s.overdueInvoices, asOf),
    overdueInvoicesSort: s.overdueInvoices?.count ?? -1,
    site: siteCell(row),
    onTime: onTimePercent(s.deliveryOnTime),
    onTimeSort: s.deliveryOnTime ?? -1,
    activeProjects: s.activeProjects,
  };
}

/** Worst first (STATE_ORDER), then the oldest thing waiting on us, then the name so the order is stable. */
export function sortWorstFirst(rows: ClientHealthRow[], asOf: string): ClientHealthRow[] {
  return [...rows].sort((a, b) =>
    healthRank(a.state) - healthRank(b.state)
    || (ageInDays(b.signals.waitingOnUs?.oldestSince, asOf) ?? -1) - (ageInDays(a.signals.waitingOnUs?.oldestSince, asOf) ?? -1)
    || a.name.localeCompare(b.name),
  );
}

export interface BoardFilter {
  state?: HealthState;
  /** `ownerUserId`, or `none` for a client with no owner. */
  owner?: string;
  /** The client ids of one department (`GET clients?departmentId=`); `null` = no department filter. */
  departmentClientIds?: ReadonlySet<string> | null;
}

export const NO_OWNER = "none";

export function filterBoard(rows: ClientHealthRow[], f: BoardFilter): ClientHealthRow[] {
  return rows.filter((r) =>
    (!f.state || r.state === f.state)
    && (!f.owner || (f.owner === NO_OWNER ? r.ownerUserId === null : r.ownerUserId === f.owner))
    && (!f.departmentClientIds || f.departmentClientIds.has(r.clientId)),
  );
}

/** The board's URL for a set of filters (`/clients/health?state=at_risk&owner=…&department=…`). */
export function healthBoardHref(f: { state?: string; owner?: string; department?: string }): string {
  const q = new URLSearchParams();
  if (f.state) q.set("state", f.state);
  if (f.owner) q.set("owner", f.owner);
  if (f.department) q.set("department", f.department);
  const s = q.toString();
  return s ? `/clients/health?${s}` : "/clients/health";
}

export function isHealthState(v: string | undefined): v is HealthState {
  return !!v && (STATE_ORDER as readonly string[]).includes(v);
}

export function stateOptions(rows: ClientHealthRow[]): Array<{ key: HealthState; label: string; count: number }> {
  return STATE_ORDER
    .map((key) => ({ key, label: STATE_LABEL[key], count: rows.filter((r) => r.state === key).length }))
    .filter((o) => o.count > 0);
}

export function ownerOptions(rows: ClientHealthRow[]): Array<{ key: string; label: string; count: number }> {
  const byId = new Map<string, { label: string; count: number }>();
  let none = 0;
  for (const r of rows) {
    if (r.ownerUserId === null) { none += 1; continue; }
    const cur = byId.get(r.ownerUserId);
    if (cur) cur.count += 1; else byId.set(r.ownerUserId, { label: r.ownerName ?? "Unnamed owner", count: 1 });
  }
  const out = [...byId.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.label.localeCompare(b.label));
  if (none > 0) out.push({ key: NO_OWNER, label: "No owner", count: none });
  return out;
}

/** "Could not be read: site monitoring, invoices." for the banner. Empty string when nothing failed. */
export function unavailableSentence(unavailable: readonly HealthSource[]): string {
  if (unavailable.length === 0) return "";
  return `Could not be read: ${unavailable.map((s) => SOURCE_LABEL[s]).join(", ")}.`;
}

/** The board's columns. `sortBy` points at a `*Sort` cell so a count column sorts by its number, not its words. */
export const BOARD_COLUMNS: Column[] = [
  { key: "name", header: "Client", sortable: true },
  { key: "health", header: "Health", format: "health", sortable: true, sortBy: "healthSort" },
  { key: "why", header: "Why" },
  { key: "waitingOnUs", header: "Waiting on us", sortable: true, sortBy: "waitingOnUsSort", sortAs: "number" },
  { key: "waitingOnClient", header: "Waiting on client", sortable: true, sortBy: "waitingOnClientSort", sortAs: "number" },
  { key: "lateWork", header: "Late work", sortable: true, sortBy: "lateWorkSort", sortAs: "number" },
  { key: "openRequests", header: "Open requests", format: "number", sortable: true },
  { key: "unanswered", header: "Unanswered messages", format: "number", sortable: true },
  { key: "overdueInvoices", header: "Overdue invoices", sortable: true, sortBy: "overdueInvoicesSort", sortAs: "number" },
  { key: "site", header: "Site" },
  { key: "onTime", header: "Delivery on time (this month)", sortable: true, sortBy: "onTimeSort", sortAs: "number" },
  { key: "activeProjects", header: "Active projects", format: "number", sortable: true },
  { key: "owner", header: "Owner", sortable: true },
];
