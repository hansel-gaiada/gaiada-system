// Client portal — TYPES + pure helpers. Deliberately CLIENT-SAFE (no `import "server-only"`), because
// the portal's live-refresh component, its money formatter and its status mapper all run in the
// browser. The readers moved to `portal-data.ts` and the writes to `portalActions.ts`, matching the
// documented module trio (see platform-ui/CLAUDE.md → "Module trio per domain").
//
// This file used to BE the reader module (WS11, `import "server-only"` at the top). Adding a
// `"use client"` live component that needs `PortalTopic` would have pulled `server-only` into the
// browser bundle — the exact failure the CLAUDE.md trap list calls out: `tsc` and vitest pass, and
// `next build` breaks. Splitting first was cheaper than debugging that later.
//
// P4-K2/K1 — urgency tier crossing into the portal reuses the ONE urgency definition
// (`lib/pmUrgency.ts`) rather than a portal-local date comparison: the entire premise of that
// module is that every surface agrees on "overdue"/"almost late"/"in time", and the portal is not
// exempt just because it renders a different set of fields. Both modules are deliberately import-
// free and client-safe on their own, so importing one from the other does not risk pulling
// `server-only` into the browser bundle.
import { taskUrgency } from "./pmUrgency";
import type { UrgencyTier } from "./pmUrgency";
export type { UrgencyTier };

// ── The BFF contract (mirrors platform-nest src/core/portal-*.controller.ts) ──────────────────────

export interface PortalRun {
  id: string;
  title: string | null;
  status: string;
  currentBlockage: string;
  /** Outstanding client decisions on this run. Optional because a server on an older tag does not
   *  send it — the list then badges nothing rather than rendering `undefined`. */
  pendingActions?: number;
}
export interface PortalGate {
  id: string;
  kind: "prd_sign" | "scope_signoff" | "customer_feedback" | string;
  status: "pending" | "decided";
  decision: string | null;
  created_at: string;
}
export interface PortalStage {
  track: string;
  name: string;
  status: string;
  artifact_ref: string | null;
}
export interface PortalRunDetail extends PortalRun {
  stages: PortalStage[];
  gates: PortalGate[];
  scopeSignoffs: Array<{ party: string; signer_name: string | null; signed_at: string }>;
}

export interface PortalNeedsYouItem {
  kind: "gate" | "contract";
  id: string;
  /** Whether clearing this needs SIGNING authority or merely an opinion. Drives whether a view-only
   *  contact sees an action or a notice — the same distinction the server enforces. */
  requires: "signature" | "feedback";
  label: string;
  context: string;
  href: string;
  since: string | null;
}

export interface PortalCurrencyTotals {
  currency: string;
  invoiced: number;
  paid: number;
  pendingConfirmation: number;
  outstanding: number;
  overdueCount: number;
  openCount: number;
}

export interface PortalOverview {
  clients: Array<{ id: string; name: string; status: string }>;
  client: { id: string; name: string; status: string } | null;
  viewOnly: boolean;
  progress: { projects: number; activeProjects: number; completedProjects: number; percent: number };
  deliverables: { total: number; delivered: number; overdue: number };
  nextMilestone: { id: string; name: string; dueDate: string | null; status: string; projectId: string; projectName: string } | null;
  needsYou: PortalNeedsYouItem[];
  finance: { byCurrency: PortalCurrencyTotals[]; primary: PortalCurrencyTotals | null };
}

export interface PortalProject {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  clientId: string | null;
  clientName: string | null;
  progressPercent: number;
  milestoneCount: number;
  milestonesDone: number;
  deliverableCount: number;
  nextMilestoneDue: string | null;
}

export interface PortalMilestone {
  id: string;
  name: string;
  status: string;
  dueDate: string | null;
  projectId?: string;
  projectName?: string;
  itemCount?: number;
  itemsDone?: number;
}

export interface PortalDeliverableFile {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  url: string | null;
  createdAt: string;
}

export interface PortalDeliverable {
  id: string;
  name: string;
  status: string;
  dueDate: string | null;
  updatedAt: string;
  projectId: string;
  projectName: string;
  fileCount?: number;
  files?: PortalDeliverableFile[];
}

export interface PortalProjectDetail extends PortalProject {
  milestones: PortalMilestone[];
  deliverables: PortalDeliverable[];
  runs: Array<{ id: string; title: string | null; status: string; pendingActions: number }>;
  /** Aggregate task counts by status. The portal never receives individual tasks — see the BFF header. */
  workload: Record<string, number>;
}

export type PortalTimelineTense = "due" | "happened";
export interface PortalTimelineEvent {
  kind: "milestone" | "deliverable" | "decision" | "contract" | "invoice" | "payment";
  id: string;
  label: string;
  status: string | null;
  at: string;
  tense: PortalTimelineTense;
  context: string | null;
  projectId: string | null;
}

export interface PortalInvoiceLine {
  description: string;
  hours?: number;
  rate?: number;
  amount: number;
}

export interface PortalInvoice {
  id: string;
  status: string;
  currency: string;
  total: number;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  clientName: string | null;
  paid: number;
  pendingConfirmation: number;
  balance: number;
  overdue: boolean;
}

export interface PortalPayment {
  id: string;
  amount: number;
  currency: string;
  paidOn: string;
  method: string;
  reference: string | null;
  status: "pending" | "confirmed" | "rejected";
  note: string | null;
  proofFileId: string | null;
  recordedAt: string;
  confirmedAt: string | null;
  rejectedReason: string | null;
}

export interface PortalInvoiceDetail {
  id: string;
  status: string;
  currency: string;
  total: number;
  lines: PortalInvoiceLine[];
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  clientName: string | null;
  clientId: string;
  payments: PortalPayment[];
  paid: number;
  balance: number;
}

export interface PortalContract {
  id: string;
  title: string;
  reference: string | null;
  version: number;
  status: string;
  value: number | null;
  currency: string;
  startsOn: string | null;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  hasDocument: boolean;
  clientSigned: boolean;
  providerSigned: boolean;
  termEnded: boolean;
}

export interface PortalContractDetail extends Omit<PortalContract, "hasDocument" | "clientSigned" | "providerSigned" | "projectName"> {
  bodyMd: string | null;
  declineReason: string | null;
  canSign: boolean;
  viewOnly: boolean;
  signatures: Array<{ party: "provider" | "client"; signerName: string | null; signerTitle: string | null; signedAt: string }>;
  document: { id: string; filename: string; contentType: string; byteSize: number; url: string | null } | null;
}

export interface PortalProfile {
  me: { id: string; name: string; email: string; title: string | null; memberSince: string } | null;
  clients: Array<{ id: string; name: string; status: string; contact: Record<string, unknown>; projectCount: number }>;
  contacts: Array<{ id: string; name: string; email: string; capability: string; status: string; clientId: string; projectId: string | null }>;
  access: {
    canSign: boolean;
    wholeClient: boolean;
    grants: Array<{ capability: string; clientId: string; clientName: string | null; projectId: string | null; projectName: string | null }>;
  };
}

/** Topics the live stream can name. Mirrors platform-nest src/core/portal-live.service.ts's
 *  `PortalTopic` — the two lists must agree, and this one is the browser's copy.
 *  `requests` (MI-02/MI-03) — a webdev change request submitted/triaged/converted. */
export type PortalTopic = "approvals" | "projects" | "deliverables" | "invoices" | "contracts" | "profile" | "requests";
export interface PortalLiveFrame { topic: PortalTopic; at: string }

// ── MI-04 — maintenance intake (webdev change requests) ───────────────────────────────────────────
//
// Mirrors platform-nest src/core/webdev-change-requests-portal.controller.ts's SELECT_COLUMNS exactly
// (list and detail share one shape there, so they share one type here too).
export type PortalChangeRequestKind = "content" | "design" | "feature" | "bug";
export type PortalChangeRequestStatus = "new" | "triaged" | "in_progress" | "done" | "declined";
export interface PortalChangeRequest {
  id: string;
  kind: PortalChangeRequestKind;
  title: string;
  body: string | null;
  status: PortalChangeRequestStatus;
  route: "control_plane" | "mini_run" | "pm_task" | null;
  clientId: string;
  projectId: string | null;
  projectName: string | null;
  pipelineRunId: string | null;
  pmTaskId: string | null;
  declinedReason: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Pure helpers (used on BOTH sides of the network) ──────────────────────────────────────────────

/** Money, formatted for a specific currency with the locale AND timeZone-independent pieces pinned.
 *
 *  `en-US` is hard-coded rather than left to the runtime: `toLocaleString` reads the host's ICU data,
 *  so a server rendering with one locale and a browser hydrating with another produce different text
 *  for the same number and React logs a hydration mismatch. That has already been a real defect here
 *  (see CLAUDE.md's locale/timezone trap), and money is the field where a silently different
 *  thousands separator is least acceptable.
 *
 *  IDR is shown without decimal places because rupiah sub-units are not used in practice and
 *  "Rp 25.000.000,00" is noise; every other currency keeps 2dp. */
export function money(amount: number | null | undefined, currency = "IDR"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const fractionDigits = currency === "IDR" || currency === "JPY" || currency === "VND" ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    // An unknown/invalid currency code must not blank a whole invoice page.
    return `${currency} ${amount.toFixed(fractionDigits)}`;
  }
}

/** A date, formatted identically on server and client. Same pinning rationale as `money`; `timeZone`
 *  is pinned too because a date rendered in the server's zone and re-rendered in the browser's can be
 *  a DAY apart, which on a due date is the difference between "today" and "overdue". */
export function portalDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "in 3 days" / "5 days ago" / "today" — computed against a caller-supplied `now` so it is pure and
 *  testable, and so a page can render it once on the server without the value drifting on hydration. */
export function relativeDays(value: string | null | undefined, now: Date): string {
  if (!value) return "";
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return "";
  // Compared at UTC-day granularity, not by millisecond difference: "tomorrow at 01:00" is 1 day away
  // even when it is 3 hours from now, and that is what a person reading a due date means.
  const dayMs = 86_400_000;
  const a = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((a - b) / dayMs);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/** Is this date in the past (UTC-day granularity)? Used for overdue styling. */
export function isPastDue(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return false;
  return Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate())
    < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Plain-language label for a raw status token, in CLIENT vocabulary rather than ours.
 *
 *  Deliberately not `humanizeStatus` from components/ui: that turns `in_progress` into "In Progress",
 *  which is fine internally and unhelpful to a client reading their own project. `todo` becoming
 *  "Not started yet" is the difference between a status board and an explanation. */
const CLIENT_STATUS_WORDS: Record<string, string> = {
  todo: "Not started",
  in_progress: "In progress",
  blocked: "On hold",
  done: "Complete",
  complete: "Complete",
  active: "In progress",
  pending: "Not started",
  awaiting_gate: "Waiting on you",
  delivered: "Delivered",
  approved: "Approved",
  draft: "Draft",
  sent: "Awaiting your action",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  void: "Cancelled",
  paid: "Paid",
  confirmed: "Confirmed",
  rejected: "Not accepted",
  archived: "Closed",
  cancelled: "Cancelled",
  // MI-04 — a webdev change request's own lifecycle (§2.2 of the design doc). `in_progress`/`done`
  // above already cover the post-triage states; only the two pre-triage ones are new.
  new: "Submitted",
  triaged: "Being reviewed",
};
export function clientStatus(status: string | null | undefined): string {
  if (!status) return "—";
  return CLIENT_STATUS_WORDS[status] ?? status.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());
}

/** Which `--status-*` token family a portal status belongs to. Returned as a token NAME, never a
 *  colour literal — `tokens.test.ts` fails the build on a hex or rgb() anywhere in components/**.css,
 *  and inline colour strings here would route straight around that guard. */
export type PortalTone = "success" | "warning" | "danger" | "info" | "neutral";
export function statusTone(status: string | null | undefined): PortalTone {
  switch (status) {
    case "done": case "complete": case "delivered": case "approved": case "signed": case "paid":
    case "confirmed":
      return "success";
    case "sent": case "awaiting_gate": case "pending": case "new":
      return "warning";
    case "blocked": case "declined": case "expired": case "rejected":
      return "danger";
    case "in_progress": case "active": case "triaged":
      return "info";
    default:
      return "neutral";
  }
}

/** Split a timeline into what is coming and what has happened, newest-first for history and
 *  soonest-first for upcoming. Pure so the page does no date maths inline (and so this ordering is
 *  covered by a test rather than by reading the JSX). */
export function splitTimeline(
  events: PortalTimelineEvent[],
  now: Date,
): { upcoming: PortalTimelineEvent[]; history: PortalTimelineEvent[] } {
  const upcoming: PortalTimelineEvent[] = [];
  const history: PortalTimelineEvent[] = [];
  for (const e of events) {
    // A `due` item whose date has passed belongs to HISTORY, not to "upcoming" — an overdue milestone
    // listed under "what's next" reads as though it were still ahead of schedule.
    if (e.tense === "due" && !isPastDue(e.at, now)) upcoming.push(e);
    else history.push(e);
  }
  upcoming.sort((a, b) => a.at.localeCompare(b.at));
  history.sort((a, b) => b.at.localeCompare(a.at));
  return { upcoming, history };
}

/** The single number the portal's headline shows. Kept here (not inline in the page) because it is the
 *  one figure a client will quote back at us, and it deserves a test. */
export function overallProgress(o: Pick<PortalOverview, "progress">): number {
  const p = o.progress?.percent;
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
}

/** A project's own authored range, formatted for the client ("14 Jul 2026 – 30 Sep 2026"). Both
 *  ends are optional in the data (a project can lack a start or a due date); each side degrades to
 *  "—" independently rather than the whole range disappearing. Client-safe projection: this is
 *  ONLY the authored `startDate`/`dueDate` pair (workstream H) — never a task-derived envelope,
 *  which is internal Gantt detail the portal must not reconstruct. */
export function projectRange(project: Pick<PortalProject, "startDate" | "dueDate">): string {
  const start = portalDate(project.startDate);
  const end = portalDate(project.dueDate);
  if (start === "—" && end === "—") return "—";
  return `${start} – ${end}`;
}

/** Urgency tier for a project's own authored due date (P4-K2, decided in K1). Reuses the ONE
 *  urgency definition (`lib/pmUrgency.ts`) rather than a portal-local date comparison — the whole
 *  premise of that module is that every surface must agree, and the portal earns no exemption.
 *  `isDone` is derived from the project's own progress percentage (100% = done) because the portal
 *  never receives an internal status label to check against — that is exactly the field K1 says
 *  must never cross. */
export function projectUrgencyTier(
  project: Pick<PortalProject, "dueDate" | "progressPercent">,
  today: string,
): UrgencyTier {
  return taskUrgency({ dueDate: project.dueDate, isDone: project.progressPercent >= 100 }, today);
}

// ── MI-04 pure helpers ─────────────────────────────────────────────────────────────────────────────

const CHANGE_REQUEST_KIND_WORDS: Record<PortalChangeRequestKind, string> = {
  content: "Content edit",
  design: "Design change",
  feature: "Feature request",
  bug: "Bug report",
};
/** A change request's `kind`, in words a client recognises rather than the schema token. */
export function changeRequestKindLabel(kind: string): string {
  return CHANGE_REQUEST_KIND_WORDS[kind as PortalChangeRequestKind] ?? kind;
}

export interface PortalProjectOption { id: string; name: string }

/** What the "New request" form's project selector may offer — computed from the caller's OWN scope
 *  shape, never re-derived from the project list (a list of projects cannot say whether its owner is
 *  client-wide or project-scoped; only `PortalProfile.access.wholeClient` can).
 *
 *  Design doc §5.1/§5.2 rule, encoded here once so the page, the demo fixture and this file's own test
 *  all read it off the same function: a CLIENT-WIDE contact (`wholeClient: true`) additionally gets an
 *  "all projects" option; a PROJECT-SCOPED contact gets NO such option and must name one of `projects`.
 *
 *  ⚠ Deliberately takes `wholeClient` and NOT `canSign`. The §5.1 ruling — test-pinned on the backend
 *  in webdev-change-requests-portal.controller.ts — is that submitting is a VIEWER-permitted act;
 *  signing capability gates only the resulting mini-run's own gates, never this form. There is no
 *  parameter here for a future edit to accidentally start gating on, and `portal.test.ts` pins that a
 *  viewer-scoped and a signer-scoped profile produce the IDENTICAL result. */
export function changeRequestFormProps(
  profile: { access: Pick<PortalProfile["access"], "wholeClient"> },
  projects: PortalProjectOption[],
): { allowClientWide: boolean; projects: PortalProjectOption[] } {
  return { allowClientWide: profile.access.wholeClient, projects };
}
