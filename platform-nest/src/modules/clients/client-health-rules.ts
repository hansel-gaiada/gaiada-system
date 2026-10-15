// PV7-02 — the client health STATE, as one pure function (BFF §54.3; plan L3 and owner question PV7-Q4, the lead's default).
//
// ── WHAT THIS IS, AND IS NOT ─────────────────────────────────────────────────────────────────────────
// Signals in, `{ state, reasons[] }` out. No I/O, no clock of its own (`now` is an argument), no database, so the
// same rules can be run by the board, by the one-client read, by a test, and by the UI's demo mirror. It is NOT a score:
// there is no number, no weighting and no "health percentage" (DW-D19). The state is STAFF-ONLY; the client portal
// shows facts (what is late, who holds the ball) and never a state label.
//
// ── THE RULES (PV7-Q4) ───────────────────────────────────────────────────────────────────────────────
//   at risk    anything waiting on us 7+ days, any late deliverable or milestone, any overdue ISSUED invoice, any open
//              site incident, or anything waiting on the client 14+ days.
//   off track  anything waiting on us 14+ days, work 14+ days late, an issued invoice 30+ days overdue, or a site
//              incident open 24+ hours.
//   quiet      nothing above, no source unavailable, no active project and no active service.
//   unknown    nothing above, a source could not be read, and the rest would say on track (or quiet): a failed read
//              must never be presented as health.
//   on track   everything else.
// A family is reported ONCE, at its highest tier (waiting on us at 14 days is `waiting_on_us_14d`, not also `_7d`).
// Ages are whole days (hours for the site rule), counted back from `now`, so "7 days" means seven full days.
//
// The golden table in `client-health-golden.json` pins every threshold on both sides; the UI mirror copies it.

export const AT_RISK_WAITING_ON_US_DAYS = 7;
export const OFF_TRACK_WAITING_ON_US_DAYS = 14;
export const AT_RISK_WAITING_ON_CLIENT_DAYS = 14;
export const OFF_TRACK_LATE_WORK_DAYS = 14;
export const OFF_TRACK_INVOICE_OVERDUE_DAYS = 30;
export const OFF_TRACK_SITE_INCIDENT_HOURS = 24;

export type HealthState = "on_track" | "at_risk" | "off_track" | "quiet" | "unknown";

export type HealthReasonCode =
  | "waiting_on_us_7d" | "waiting_on_us_14d"
  | "waiting_on_client_14d"
  | "late_work" | "late_work_14d"
  | "invoice_overdue" | "invoice_overdue_30d"
  | "site_incident_open" | "site_incident_open_24h"
  | "no_active_work"
  | "source_unavailable";

/** `count` is the size of the family that raised the reason; `since` is the family's oldest instant or date (or null). */
export interface HealthReason { code: HealthReasonCode; count: number; since: string | null }

/** The reads the board makes, each on its own. A failed one is named in `unavailable[]`, never counted as zero. */
export type HealthSource =
  | "projects" | "ball" | "milestones" | "deliverables" | "requests" | "invoices"
  | "site" | "services" | "modules" | "projectHealth" | "turnaround";

/** Items waiting, with the oldest one's instant (ISO). */
export interface Aged { count: number; oldestSince: string | null }
/** Late or overdue things, with the oldest one's due date (YYYY-MM-DD). */
export interface DueAged { count: number; oldestDue: string | null }

/** The signals the rules read. `null` means "no answer" (the source failed, or does not apply): treated as nothing
 *  here, and the caller lists a failed source in `unavailable`, which is what makes the state `unknown`. */
export interface HealthRuleInput {
  waitingOnUs: Aged | null;
  waitingOnClient: Aged | null;
  lateDeliverables: DueAged | null;
  lateMilestones: DueAged | null;
  overdueInvoices: DueAged | null;
  site: { openIncidents: number; oldestOpenSince: string | null } | null;
  activeProjects: number | null;
  activeServices: number | null;
}

export interface HealthVerdict { state: HealthState; reasons: HealthReason[] }

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Whole units elapsed between `from` (ISO instant or YYYY-MM-DD, read as UTC) and `now`; 0 for a future or unparseable value. */
function elapsed(from: string | null, now: Date, unitMs: number): number {
  if (!from) return 0;
  const t = Date.parse(from);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / unitMs));
}

type Tier = "off" | "at";

/** Family order is the tie-break inside a tier, so a payload's reasons are stable. */
interface Candidate { family: number; tier: Tier; reason: HealthReason }

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b; // ISO instants and YYYY-MM-DD both sort as text
}

export function evaluateClientHealth(input: HealthRuleInput, unavailable: readonly HealthSource[], now: Date): HealthVerdict {
  const found: Candidate[] = [];

  // 0 · waiting on us
  if (input.waitingOnUs && input.waitingOnUs.count > 0) {
    const w = input.waitingOnUs;
    const age = elapsed(w.oldestSince, now, DAY_MS);
    if (age >= OFF_TRACK_WAITING_ON_US_DAYS) found.push({ family: 0, tier: "off", reason: { code: "waiting_on_us_14d", count: w.count, since: w.oldestSince } });
    else if (age >= AT_RISK_WAITING_ON_US_DAYS) found.push({ family: 0, tier: "at", reason: { code: "waiting_on_us_7d", count: w.count, since: w.oldestSince } });
  }

  // 1 · late work: late deliverables and late milestones are one family
  const lateCount = (input.lateDeliverables?.count ?? 0) + (input.lateMilestones?.count ?? 0);
  if (lateCount > 0) {
    const since = earlier(
      (input.lateDeliverables?.count ?? 0) > 0 ? input.lateDeliverables!.oldestDue : null,
      (input.lateMilestones?.count ?? 0) > 0 ? input.lateMilestones!.oldestDue : null,
    );
    const off = elapsed(since, now, DAY_MS) >= OFF_TRACK_LATE_WORK_DAYS;
    found.push({ family: 1, tier: off ? "off" : "at", reason: { code: off ? "late_work_14d" : "late_work", count: lateCount, since } });
  }

  // 2 · overdue issued invoices
  if (input.overdueInvoices && input.overdueInvoices.count > 0) {
    const i = input.overdueInvoices;
    const off = elapsed(i.oldestDue, now, DAY_MS) >= OFF_TRACK_INVOICE_OVERDUE_DAYS;
    found.push({ family: 2, tier: off ? "off" : "at", reason: { code: off ? "invoice_overdue_30d" : "invoice_overdue", count: i.count, since: i.oldestDue } });
  }

  // 3 · site incidents
  if (input.site && input.site.openIncidents > 0) {
    const s = input.site;
    const off = elapsed(s.oldestOpenSince, now, HOUR_MS) >= OFF_TRACK_SITE_INCIDENT_HOURS;
    found.push({ family: 3, tier: off ? "off" : "at", reason: { code: off ? "site_incident_open_24h" : "site_incident_open", count: s.openIncidents, since: s.oldestOpenSince } });
  }

  // 4 · waiting on the client (at risk only: a client's silence is a risk to the relationship, not our failure)
  if (input.waitingOnClient && input.waitingOnClient.count > 0) {
    const w = input.waitingOnClient;
    if (elapsed(w.oldestSince, now, DAY_MS) >= AT_RISK_WAITING_ON_CLIENT_DAYS) {
      found.push({ family: 4, tier: "at", reason: { code: "waiting_on_client_14d", count: w.count, since: w.oldestSince } });
    }
  }

  const tierRank = (t: Tier) => (t === "off" ? 0 : 1);
  found.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.family - b.family);
  const reasons = found.map((f) => f.reason);

  if (found.some((f) => f.tier === "off")) return { state: "off_track", reasons };
  if (found.length > 0) return { state: "at_risk", reasons };

  const failed = new Set(unavailable);
  if (failed.size > 0) return { state: "unknown", reasons: [{ code: "source_unavailable", count: failed.size, since: null }] };

  if ((input.activeProjects ?? 0) === 0 && (input.activeServices ?? 0) === 0) {
    return { state: "quiet", reasons: [{ code: "no_active_work", count: 0, since: null }] };
  }
  return { state: "on_track", reasons: [] };
}
