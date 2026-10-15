// Client health (PV7-02 backend, PV7-03 UI): the wire shapes of FRONTEND-BFF-CONTRACT §54 and the words the UI
// uses for them. Client-safe: no I/O, no `server-only` (the readers live in `clientHub.ts` and `portal-data.ts`).
//
// ── ONE LABEL MAP, TWO SURFACES ─────────────────────────────────────────────────────────────────────
// `STATE_LABEL` and `describeReason` are the only place a state or a reason code becomes words. The staff hub (PV7-03)
// and the staff board (PV7-05) both read them, so a state never reads one way on the hub and another on the board.
// The portal NEVER uses either of them: the health state is staff-only and is never a score (L3), and the portal's
// payload does not carry one.
//
// ── NULL IS "NO ANSWER" ─────────────────────────────────────────────────────────────────────────────
// Every section of a payload is `null` when its source failed. A `null` is drawn as `COULD_NOT_BE_LOADED`, never as
// zero, an empty list or an on-track state: an empty list is a claim (BFF §54.2).

export type HealthState = "on_track" | "at_risk" | "off_track" | "quiet" | "unknown";

export type HealthReasonCode =
  | "waiting_on_us_7d" | "waiting_on_us_14d"
  | "waiting_on_client_14d"
  | "late_work" | "late_work_14d"
  | "invoice_overdue" | "invoice_overdue_30d"
  | "site_incident_open" | "site_incident_open_24h"
  | "no_active_work"
  | "source_unavailable";

export interface HealthReason { code: HealthReasonCode; count: number; since: string | null }

export type HealthSource =
  | "projects" | "ball" | "milestones" | "deliverables" | "requests" | "invoices"
  | "site" | "services" | "modules" | "projectHealth" | "turnaround";

export interface Aged { count: number; oldestSince: string | null }
export interface DueAged { count: number; oldestDue: string | null }

export interface MilestoneCounts { total: number; done: number; upcoming: number; late: number; undated: number }
export interface DeliverableCounts { total: number; delivered: number; late: number }
export interface NextMilestone { id: string; name: string; dueDate: string }

export type TurnaroundKind =
  | "client_gate" | "contract_signed" | "post_review"
  | "change_request_triage" | "payment_confirmed" | "conversation_reply";

export interface TurnaroundPart { kind: TurnaroundKind; medianDays: number | null; n: number; withheld: boolean; clientVisible: boolean }
export interface Turnaround { medianDays: number | null; n: number; withheld: boolean; parts: TurnaroundPart[] }

export interface ProjectHealth {
  projectId: string; name: string; status: string;
  /** A client-wide contact sees this project (computed by the backend from the portal's own predicates). */
  clientVisible: boolean;
  milestones: MilestoneCounts;
  deliverables: DeliverableCounts;
  nextMilestone: NextMilestone | null;
}

/** One client's signals (§54.2). `null` is "no answer" (the source failed, or does not apply), never zero. */
export interface ClientHealthSignals {
  waitingOnUs: Aged | null;
  waitingOnClient: Aged | null;
  lateDeliverables: DueAged | null;
  lateMilestones: DueAged | null;
  openChangeRequests: number | null;
  conversationsAwaitingReply: number | null;
  overdueInvoices: DueAged | null;
  site: { openIncidents: number; oldestOpenSince: string | null; uptime30d: number | null } | null;
  /** Always `null` until PV7-01's client-grain overview supplies it. */
  deliveryOnTime: null;
  activeProjects: number | null;
  activeServices: number | null;
}

/** A board row (`GET :t/clients/health`, PV7-05) and the head of the one-client read. */
export interface ClientHealthRow {
  clientId: string; name: string; status: string;
  ownerUserId: string | null; ownerName: string | null;
  state: HealthState; reasons: HealthReason[];
  signals: ClientHealthSignals;
}

/** `GET :t/clients/:clientId/health` (staff, one client). */
export interface ClientHealthDetail extends ClientHealthRow {
  asOf: string;
  onTimeKnownSince: string | null;
  unavailable: HealthSource[];
  projects: ProjectHealth[] | null;
  turnaround: { windowDays: 90; client: Turnaround; ours: Turnaround } | null;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────

export const COULD_NOT_BE_LOADED = "Could not be loaded";
export const NOT_ENOUGH_YET = "Not enough yet";

export const STATE_LABEL: Record<HealthState, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  quiet: "Quiet",
  unknown: "Unknown",
};

/** One line under the chip: what each state means, in the words the rules table (§54.3) uses. */
export const STATE_MEANING: Record<HealthState, string> = {
  on_track: "Nothing is waiting too long, late or overdue.",
  at_risk: "Something needs attention soon.",
  off_track: "Something has been waiting, late or overdue for a long time.",
  quiet: "No active projects or services right now.",
  unknown: "At least one source could not be read, so the state cannot be judged.",
};

export const SOURCE_LABEL: Record<HealthSource, string> = {
  projects: "projects",
  ball: "who is waiting on whom",
  milestones: "milestones",
  deliverables: "deliverables",
  requests: "change requests",
  invoices: "invoices",
  site: "site monitoring",
  services: "services",
  modules: "module settings",
  projectHealth: "per-project health",
  turnaround: "reply times",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date or instant as "08 Oct 2026", in UTC. Built by hand rather than with `toLocaleDateString`: ICU versions disagree
 *  on the month's short form ("Sep" against "Sept" for en-GB), so a runtime-formatted date can differ between the server
 *  and the browser (a hydration mismatch) and between Node versions (a flaky test). `—` for nothing or a non-date. */
export function healthDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The plain-words sentence for a reason, without its date. Every `HealthReasonCode` of §54.2 has one. The waiting
 *  reasons say "awaiting us" / "awaiting the client", deliberately NOT "waiting on us": that phrase is the hub's two list
 *  headings, and a second element carrying it breaks every test and every reader that finds those lists by their text. */
export function reasonLabel(r: HealthReason): string {
  const n = r.count;
  switch (r.code) {
    case "waiting_on_us_7d": return `${plural(n, "item", "items")} awaiting us for 7 days or more`;
    case "waiting_on_us_14d": return `${plural(n, "item", "items")} awaiting us for 14 days or more`;
    case "waiting_on_client_14d": return `${plural(n, "item", "items")} awaiting the client for 14 days or more`;
    case "late_work": return `${plural(n, "late deliverable or milestone", "late deliverables and milestones")}`;
    case "late_work_14d": return `${plural(n, "late deliverable or milestone", "late deliverables and milestones")}, the oldest 14 days or more late`;
    case "invoice_overdue": return plural(n, "overdue invoice", "overdue invoices");
    case "invoice_overdue_30d": return `${plural(n, "overdue invoice", "overdue invoices")}, the oldest 30 days or more overdue`;
    case "site_incident_open": return plural(n, "open site incident", "open site incidents");
    case "site_incident_open_24h": return `${plural(n, "open site incident", "open site incidents")}, the oldest open for 24 hours or more`;
    case "no_active_work": return "No active projects or services";
    case "source_unavailable": return `${plural(n, "source", "sources")} could not be read`;
  }
}

/** The reason as one line for the hub: the sentence, then the family's oldest date when it has one. */
export function describeReason(r: HealthReason): string {
  const label = reasonLabel(r);
  return r.since ? `${label} (oldest ${healthDate(r.since)})` : label;
}

/** A turnaround in days, one decimal at most: `1 day`, `2.5 days`, `0.4 days`. */
export function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/** A turnaround as a value: days, `Not enough yet` when the backend withheld it (below 3 samples), and
 *  `Could not be loaded` when the whole turnaround read failed (`null`). */
export function turnaroundValue(t: Pick<Turnaround, "medianDays" | "withheld"> | null | undefined): string {
  if (t == null) return COULD_NOT_BE_LOADED;
  if (t.withheld || t.medianDays === null) return NOT_ENOUGH_YET;
  return formatDays(t.medianDays);
}

/** "You usually reply in 2 days" / "We usually reply in 1.5 days". A side the backend withheld (below 3 samples) reads
 *  "Not enough yet to say how quickly you reply", never a made-up number; a failed read (`null`) reads
 *  "Could not be loaded". */
export function turnaroundSentence(who: "You" | "We", t: Pick<Turnaround, "medianDays" | "withheld"> | null | undefined): string {
  if (t == null) return COULD_NOT_BE_LOADED;
  if (t.withheld || t.medianDays === null) return `${NOT_ENOUGH_YET} to say how quickly ${who.toLowerCase()} reply`;
  return `${who} usually reply in ${formatDays(t.medianDays)}`;
}

export const TURNAROUND_KIND_LABEL: Record<TurnaroundKind, string> = {
  client_gate: "Approvals the client decided",
  contract_signed: "Agreements the client signed",
  post_review: "Post reviews the client decided",
  change_request_triage: "Change requests we triaged",
  payment_confirmed: "Client payments we confirmed",
  conversation_reply: "Conversation turns we replied to",
};

/** Our side's kinds and the client's, so the staff card can group the parts under the right heading. */
export const CLIENT_SIDE_KINDS: ReadonlySet<TurnaroundKind> = new Set<TurnaroundKind>(["client_gate", "contract_signed", "post_review"]);

/** A project is finished when it is no longer active work (the backend's own rule for an "active project"). Used only
 *  to decide what the portal lists by default: the portal's Projects page keeps finished ones under Past. */
export function isFinishedProjectStatus(status: string): boolean {
  return ["completed", "complete", "done", "archived", "cancelled"].includes(status.toLowerCase());
}
