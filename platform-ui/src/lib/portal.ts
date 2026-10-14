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
  /** PV4-06 (§29d): threads in the caller's scope with at least one unread message from staff. Optional: an older
   *  server does not send it, and the Projects badge then adds nothing. */
  conversationUnread?: number;
}

export interface PortalProject {
  id: string;
  name: string;
  status: string;
  /** PV2-03: server-derived "finished" (completed/archived/cancelled since PV2-09). Optional for an
   *  older backend; never re-derive it from `status` in the UI. */
  finished?: boolean;
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
  /** PV2-03: the project's owner; null when none or the owner is deleted/disabled. */
  lead?: { name: string; email: string } | null;
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
  /** NULL for an undated item (a milestone or deliverable with no due date): the live BFF sends it, so
   *  every reader must cope. Typed `string` until 2026-10-11, which let a sort crash the whole page. */
  at: string | null;
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
  /** PV5-04: past its DUE date and not fully paid (a legacy invoice with no due date: its period end). */
  overdue: boolean;
  /** PV5-04: the invoice of record. Null on an invoice issued before PV-5; optional for an older server. */
  invoiceNo?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  taxCode?: string | null;
  issuer?: PortalInvoiceIssuer | null;
  /** What is still owed per the ledger. */
  outstanding?: number;
  /** The invoice accepts a payment claim now. When false, the "Tell us you've paid" form is not offered. */
  payable?: boolean;
  /** PV5-07: the stored PDF of an issued invoice. Absent (an older server) and null (not rendered yet) read alike: an
   *  issued invoice says "being prepared", any other says nothing (lib/billingView.ts). Downloaded through the portal's
   *  own file route, never the staff one. */
  pdfFileId?: string | null;
}

/** PV5-04: the issuer as frozen on the invoice when it was issued (the bank block is where to pay). */
export interface PortalInvoiceIssuer {
  legalName: string | null;
  address: string | null;
  npwp: string | null;
  isPkp: boolean | null;
  bank: { name: string | null; accountName: string | null; accountNo: string | null } | null;
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
  // PV5-04 (see PortalInvoice): optional for an older server.
  invoiceNo?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  subtotal?: number | null;
  taxTotal?: number | null;
  taxCode?: string | null;
  taxLines?: Array<{ code: string; rate: number | null; base: number; amount: number }>;
  issuer?: PortalInvoiceIssuer | null;
  outstanding?: number;
  payable?: boolean;
  overdue?: boolean;
  /** PV5-07: see `PortalInvoice.pdfFileId`. */
  pdfFileId?: string | null;
  /** PV5-10: whether "Pay online" is offered, decided by the backend (never guessed here). `reason` and `message` when
   *  not; an older server omits the field, which reads as "not offered". */
  onlinePayment?: { available: boolean; amount?: number; currency?: string; reason?: string; message?: string };
}

/** PV-D41: the simulated hosted payment page's data (review stage only; the BFF answers 404 when simulation is off). */
export interface PortalSimulatedPayment {
  simulated: true;
  orderId: string;
  invoiceId: string;
  invoiceNo: string | null;
  amount: number;
  currency: string;
  /** null: nothing chosen yet; else the simulated provider's word (pending, settlement, deny, expire). */
  transactionStatus: string | null;
  canAct: boolean;
  returnUrl: string;
}

/** PV-D41: the three choices on the simulated page, in the order shown. */
export const SIMULATED_ACTIONS = [
  { action: "pay", label: "Pay (simulated)" },
  { action: "pending", label: "Leave pending" },
  { action: "fail", label: "Payment fails" },
] as const;

/** PV-D41: the simulated provider's word, in plain words. */
export function simulatedStatusText(status: string | null): string {
  switch (status) {
    case null: return "Nothing chosen yet.";
    case "pending": return "Left pending: no money has moved yet.";
    case "settlement": return "Paid (simulated). No real money moved.";
    case "deny": return "The simulated payment failed.";
    case "expire": return "This simulated payment expired.";
    default: return status;
  }
}

/** PV5-10: is this a safe place to send the payer? The provider's own https page (the backend has already checked the
 *  host), or one of our own paths (the demo fixture's stand-in). Never a protocol-relative or other-scheme URL. */
export function isCheckoutUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.startsWith("/")) return !url.startsWith("//") && !url.startsWith("/\\");
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** PV5-10: the payer has just come back from the provider's page (our own `?checkout=finished`, or the provider's own
 *  return parameters on the dashboard's Finish URL). Only words follow from it; the payment itself comes from the
 *  verified provider notice alone. */
export function isCheckoutReturn(sp: Record<string, string | string[] | undefined> | undefined): boolean {
  if (!sp) return false;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  return first(sp.checkout).startsWith("finished") || first(sp.transaction_status) !== "" || first(sp.order_id) !== "";
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
  /** PV5-07: the sealed signed copy (the contract, its evidence page and the company seal), once rendered. Absent and null
   *  read alike: a SIGNED contract says "being prepared", any other says nothing (lib/billingView.ts). */
  signedCopyFileId?: string | null;
  /** PV4-04 (§16b): `amendment` changes the terms of an earlier signed contract; it never voids or replaces it.
   *  Optional for an older server (read as an ordinary agreement). `amendsReference` and `changeRequestId` are
   *  already filtered through the caller's own scope, so out of reach reads `null`. */
  kind?: "agreement" | "amendment";
  amendsId?: string | null;
  amendsReference?: string | null;
  changeRequestId?: string | null;
}

export interface PortalContractDetail extends Omit<PortalContract, "hasDocument" | "clientSigned" | "providerSigned" | "projectName"> {
  bodyMd: string | null;
  declineReason: string | null;
  canSign: boolean;
  viewOnly: boolean;
  /** PV5-06: the SHA-256 the server fixed when the contract was sent. The sign call echoes it back ("what I saw");
   *  the server refuses (409) when the content changed since. Null on a contract sent before PV5-06. Optional so
   *  demo fixtures need not carry one. */
  contentSha256?: string | null;
  /** PV5-06: `attested` (typed name) or `certified` (signed through a certified provider; never by typed name). */
  signatureTier?: "attested" | "certified" | null;
  signatures: Array<{ party: "provider" | "client"; signerName: string | null; signerTitle: string | null; signedAt: string }>;
  document: { id: string; filename: string; contentType: string; byteSize: number; url: string | null } | null;
}

export interface PortalProfile {
  me: { id: string; name: string; email: string; title: string | null; memberSince: string } | null;
  clients: Array<{ id: string; name: string; status: string; contact: Record<string, unknown>; projectCount: number;
    /** PV2-03: `clients.owner_user_id`; null when unset. */
    accountManager?: { name: string; email: string } | null }>;
  contacts: Array<{ id: string; name: string; email: string; capability: string; status: string; clientId: string; projectId: string | null;
    /** PV2-03: `client` = the client's own person; `provider` = our staff holding a contact row. */
    side?: "client" | "provider" }>;
  access: {
    /** Display summary: the caller can sign on at least one of their clients. Authorizes nothing (§29b). */
    canSign: boolean;
    /** Display summary: the caller is client-wide on at least one of their clients. Authorizes nothing. */
    wholeClient: boolean;
    /** PER CLIENT (portal scope kernel, 2026-10-13): the clients the caller may sign for. Absent on an older server. */
    signerClientIds?: string[];
    /** PER CLIENT: the clients the caller reaches client-wide (every project, the General thread, client-wide
     *  change requests). Absent on an older server. */
    wideClientIds?: string[];
    grants: Array<{ capability: string; clientId: string; clientName: string | null; projectId: string | null; projectName: string | null }>;
  };
}

/** Topics the live stream can name. Mirrors platform-nest src/core/portal-live.service.ts's
 *  `PortalTopic` — the two lists must agree, and this one is the browser's copy.
 *  `requests` (MI-02/MI-03) — a webdev change request submitted/triaged/converted.
 *  `conversation` (PV4-03) — a conversation thread opened/updated, a message posted.
 *
 *  ⚠ SMM-32 does NOT add a `"social_reviews"` member here: `portal-live.service.ts`'s own
 *  `PortalTopic` union was not touched by SMM-31's backend work, so no SSE frame is ever emitted
 *  naming this surface — inventing a client-side topic string with nothing on the wire to match it
 *  would be exactly the kind of confident-but-wrong drift this file's own header warns against. The
 *  social-reviews pages render `<PortalLive />` with no `topics` filter instead, so they still
 *  refresh on the unconditional idle poll (and on any OTHER topic's frame) — see that component's
 *  own header for why the poll is never purely a fallback. */
export type PortalTopic = "approvals" | "projects" | "deliverables" | "invoices" | "contracts" | "profile" | "requests" | "conversation";
export interface PortalLiveFrame { topic: PortalTopic; at: string }

// ── SMM-31/32 — the client's own review of a drafted social post (D-16) ───────────────────────────
//
// Mirrors `social-client-review-portal.controller.ts`'s exact response shape (docs/FRONTEND-BFF-
// CONTRACT.md §16h). Only two statuses are ever DECIDED by the client (`approved`/
// `changes_requested`); `pending`/`withdrawn` are states the client can only ever READ, never post
// as a decision — `SocialReviewDecision` names the narrower set the decide form may submit.
export type SocialReviewStatus = "pending" | "approved" | "changes_requested" | "withdrawn";
export type SocialReviewDecision = "approved" | "changes_requested";

export interface PortalSocialReview {
  id: string;
  status: SocialReviewStatus;
  comment: string | null;
  requestedAt: string;
  decidedAt: string | null;
  variantId: string;
  body: string;
  media: unknown[];
  settings: Record<string, unknown>;
  scheduledAt: string | null;
  network: string;
  postTitle: string;
}

const SOCIAL_REVIEW_STATUS_WORDS: Record<SocialReviewStatus, string> = {
  pending: "Awaiting your decision",
  approved: "Approved",
  changes_requested: "Changes requested",
  withdrawn: "Withdrawn by the team",
};
/** Plain-language label for a review's own status — CLIENT vocabulary, not `clientStatus`'s (that
 *  map has no entries for `changes_requested`/`withdrawn` in this review-specific sense and would
 *  fall through to a mechanical underscore-replace; this one is deliberate and full-coverage). */
export function socialReviewStatusLabel(status: SocialReviewStatus): string {
  return SOCIAL_REVIEW_STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

export function socialReviewStatusTone(status: SocialReviewStatus): PortalTone {
  switch (status) {
    case "approved": return "success";
    case "pending": return "warning";
    case "changes_requested": return "info";
    case "withdrawn": return "neutral";
    default: return "neutral";
  }
}

/** The one token the portal decide action can receive back that ISN'T plain prose: a genuine
 *  conflict (this review was already decided differently — see `social-client-review-portal.
 *  controller.ts`'s idempotent-decision doctrine). Every other error the decide call can throw
 *  (404 "review not found", a validation 400) is plain English already and is surfaced verbatim by
 *  `portalActions.ts`'s `fail()`, matching that file's own "the backend's own message is written
 *  for a client to read" rule — this map exists ONLY for the one snake_case token among them. */
const SOCIAL_REVIEW_ERROR_WORDS: Record<string, string> = {
  client_review_already_decided: "This was already decided, and it doesn't match what you just submitted — refresh the page to see the current status.",
};
export function describeSocialReviewError(message: string): string {
  return SOCIAL_REVIEW_ERROR_WORDS[message] ?? message;
}

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
  // Bug detail (BFF contract §16f). Present on every row, `null` for non-bug kinds — the backend
  // selects these columns unconditionally, so a row that omitted them here would make a stored repro
  // step indistinguishable from one the client never typed.
  // `severity` is READ-only: set by us at triage, never submitted by the reporter.
  severity: "critical" | "high" | "medium" | "low" | null;
  reproSteps: string | null;
  environment: string | null;
  seenOnVersion: string | null;
  affectedUrl: string | null;
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
    case "done": case "complete": case "completed": case "delivered": case "approved": case "signed": case "paid":
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
  // Undated items sort LAST in both lists. A plain `a.at.localeCompare(b.at)` threw on the live system
  // ("Cannot read properties of null") and took the whole timeline page down with it.
  const byAt = (dir: 1 | -1) => (a: PortalTimelineEvent, b: PortalTimelineEvent): number => {
    if (a.at === b.at) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return dir * a.at.localeCompare(b.at);
  };
  upcoming.sort(byAt(1));
  history.sort(byAt(-1));
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

/** What the contract page's signing card shows, decided from the SERVER's read of the agreement.
 *
 *  ── WHY THE SIGNED STATE IS DECIDED HERE AND NOT IN THE SIGN FORM'S LOCAL STATE ─────────────────────
 *  The sign action revalidates the contract page. Since Next 16.3 that refresh is actually applied in
 *  the same response as the action's result (16.2 silently dropped it — vercel/next.js#88343), and the
 *  refreshed read says `canSign: false`, so the form that held "Signed — thank you" in its
 *  `useActionState` state is unmounted the moment the signature lands. `PortalLive` does the same on the
 *  next `contracts` frame or idle poll, on ANY Next version. So the confirmation has to be something the
 *  server renders from the recorded signature, or the client never sees it.
 *
 *  ── ORDER MATTERS: A CLIENT SIGNATURE WINS OVER EVERY "CAN'T SIGN" REASON ─────────────────────────────
 *  A signed agreement is signed whoever is looking. Checking `viewOnly` first told a view-only colleague
 *  that "a colleague with signing rights needs to sign this" about an agreement already signed. */
export type ContractSigningState =
  | { kind: "signed"; signerName: string | null; signerTitle: string | null; signedAt: string }
  | { kind: "sign" }
  | { kind: "closed"; reason: string };

export function contractSigningState(
  k: Pick<PortalContractDetail, "canSign" | "viewOnly" | "termEnded" | "status" | "signatures" | "document" | "bodyMd"> & { signatureTier?: PortalContractDetail["signatureTier"] },
): ContractSigningState {
  const clientSig = k.signatures.find((s) => s.party === "client");
  if (clientSig) {
    return { kind: "signed", signerName: clientSig.signerName, signerTitle: clientSig.signerTitle, signedAt: clientSig.signedAt };
  }
  // Only offered when the DOCUMENT exists: a signature on terms the client cannot read is the one state
  // the contract page must refuse to produce.
  if (k.canSign && (k.document || k.bodyMd)) return { kind: "sign" };
  return {
    kind: "closed",
    reason: k.viewOnly
      ? "Your access to this portal is view-only, so a colleague with signing rights needs to sign this. You can read everything here and forward it to them."
      : k.termEnded
        ? "This agreement's term has ended. Ask your account manager to re-issue it."
        : k.status !== "sent"
          ? `This agreement is ${clientStatus(k.status).toLowerCase()} and can't be signed here.`
          : k.signatureTier === "certified"
            ? "This agreement is signed through a certified signing provider, not by typed name. Your account manager will send you the signing link."
            : "The document needs to be attached before this can be signed.",
  };
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

/** A client the caller may be offered by name (the "whole account" and General choices). */
export interface PortalClientChoice { id: string; name: string }

/** The clients the caller reaches CLIENT-WIDE, with names, from `GET /portal/profile` (PV4-13). The server's
 *  `access.wideClientIds` is the authority; a profile from an older server that lacks it falls back to "every client"
 *  for a contact whose `wholeClient` summary is true (the only case where that was ever right: one client). A client
 *  the profile does not name keeps a neutral label rather than being dropped, so the choice still exists. */
export function wideClientChoices(
  profile: { clients?: Array<{ id: string; name: string }>; access: { wholeClient: boolean; wideClientIds?: string[] } },
): PortalClientChoice[] {
  const names = new Map((profile.clients ?? []).map((c) => [c.id, c.name]));
  const ids = profile.access.wideClientIds ?? (profile.access.wholeClient ? [...names.keys()] : []);
  return ids.map((id) => ({ id, name: names.get(id) ?? "Your account" }));
}

/** The value of a "whole account" option in the change-request project selector: `client:<clientId>`. A real project
 *  id is a bare uuid, so the two can never be confused. */
export const WHOLE_ACCOUNT_PREFIX = "client:";
export function wholeAccountValue(clientId: string): string { return `${WHOLE_ACCOUNT_PREFIX}${clientId}`; }
/** The client named by a selector value, or null when it is a project id (or blank). */
export function parseWholeAccount(value: string): string | null {
  return value.startsWith(WHOLE_ACCOUNT_PREFIX) ? value.slice(WHOLE_ACCOUNT_PREFIX.length) || null : null;
}

/** What the "New request" form's project selector may offer — computed from the caller's OWN scope
 *  shape, never re-derived from the project list (a list of projects cannot say whether its owner is
 *  client-wide or project-scoped; only the profile's `access` can).
 *
 *  Design doc §5.1/§5.2 rule, encoded here once so the page, the demo fixture and this file's own test
 *  all read it off the same function. PER CLIENT since 2026-10-13 (PV4-13): a "whole account" request is offered
 *  for each client the caller reaches CLIENT-WIDE (`wideClients`, from `access.wideClientIds`), never for a client
 *  where they are limited to some projects (the server answers 400 "select one of your projects"). A contact who is
 *  client-wide on A and project-scoped on B is offered "whole account" for A and must name a project for B.
 *  `projects` is every project the caller may name, whichever client it is on.
 *
 *  ⚠ Deliberately takes the reach and NOT `canSign`. The §5.1 ruling — test-pinned on the backend
 *  in webdev-change-requests-portal.controller.ts — is that submitting is a VIEWER-permitted act;
 *  signing capability gates only the resulting mini-run's own gates, never this form. There is no
 *  parameter here for a future edit to accidentally start gating on, and `portal.test.ts` pins that a
 *  viewer-scoped and a signer-scoped profile produce the IDENTICAL result. */
export function changeRequestFormProps(
  profile: Parameters<typeof wideClientChoices>[0],
  projects: PortalProjectOption[],
): { wideClients: PortalClientChoice[]; projects: PortalProjectOption[] } {
  return { wideClients: wideClientChoices(profile), projects };
}

// ── PV4-08: Conversation and meeting notes (§29, §29c) ─────────────────────────────────────────────
//
// Mirrors `portal-conversation.controller.ts` and the portal meetings routes. A message body is PLAIN TEXT
// (design decision 7): the UI renders it as text and only makes URLs clickable (`linkify`, lib/linkify.ts).

export interface PortalThread {
  id: string;
  clientId: string;
  clientName: string | null;
  /** NULL for the client-wide ("general") thread. */
  projectId: string | null;
  projectName: string | null;
  general: boolean;
  subject: string | null;
  status: "open" | "closed";
  createdSide: "client" | "staff";
  lastMessageAt: string | null;
  createdAt: string;
  /** Messages from the OTHER side newer than the caller's read marker. Absent on the detail route. */
  unreadCount?: number;
}

export interface PortalMessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

export interface PortalMessage {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string | null;
  authorSide: "client" | "staff";
  /** Messages are permanent (PV-D34): the body is always present, and there is no edited/retracted/editableUntil. */
  body: string;
  createdAt: string;
  mine: boolean;
  attachments: PortalMessageAttachment[];
}

export interface PortalConversationList {
  threads: PortalThread[];
  /** True when the caller is client-wide on at least one client. A summary: use `generalClientIds` to decide WHERE. */
  canUseGeneral: boolean;
  /** PER CLIENT (2026-10-13): the clients whose General thread the caller may read and post to (those they reach
   *  client-wide). General is offered for these clients only; for any other client of theirs it does not exist. */
  generalClientIds: string[];
}
export interface PortalConversationDetail { thread: PortalThread; messages: PortalMessage[] }

/** Shared meeting minutes (§29c). `bodyMd` is Markdown: render it with `ArtifactMarkdown`, never as HTML. */
export interface PortalMeetingMinutes {
  id: string;
  title: string;
  meetingDate: string | null;
  bodyMd: string;
  sharedAt: string | null;
  sharedBy: string | null;
}

/** The composer's limits, from §29: 10,000 characters, at most 5 files and 10 MB in total per message. */
export const CONVERSATION_BODY_MAX = 10_000;
export const CONVERSATION_MAX_FILES = 5;
export const CONVERSATION_MAX_BYTES = 10 * 1024 * 1024;
/** The character counter appears once the body is this long. */
export const CONVERSATION_COUNTER_FROM = 9_000;
/** The sentence under every composer (plan §2.4), verbatim. */
export const CONVERSATION_PRICE_HINT = "Prices and terms change only through a signed contract or amendment.";
/** PV-D34: shown beside the price hint on every composer, staff and portal. Messages are permanent. */
export const CONVERSATION_PERMANENT_HINT = "Messages can't be edited or removed once sent. Post a correction instead.";

/** The client-side attachment check, run BEFORE anything is sent so the client gets a plain sentence rather than a
 *  server refusal. The server enforces the same limits (§29); this is the fast path. Null = fine. */
export function attachmentProblem(files: ReadonlyArray<{ name: string; size: number }>): string | null {
  if (files.length > CONVERSATION_MAX_FILES) {
    return `You can attach up to ${CONVERSATION_MAX_FILES} files to one message. Remove ${files.length - CONVERSATION_MAX_FILES} and try again.`;
  }
  const empty = files.find((f) => f.size === 0);
  if (empty) return `${empty.name} is empty. Remove it and try again.`;
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > CONVERSATION_MAX_BYTES) {
    return `Your files add up to ${(total / (1024 * 1024)).toFixed(1)} MB. One message can carry 10 MB in total, so remove some or send them in a second message.`;
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ThreadGroup { key: string; title: string; threads: PortalThread[] }

/** The Conversation list's shape: General thread(s) pinned first, then one group per project (projects in the
 *  order of their most recent activity). PER CLIENT: a General thread is shown only for a client in
 *  `generalClientIds` (PV4-Q1: a contact limited to some projects of a client never sees that client's client-wide
 *  thread); a stray general row of any other client is dropped rather than shown. A contact of several clients gets
 *  one General per client, named by `clientName`. */
export function groupThreads(
  threads: PortalThread[],
  generalClientIds: readonly string[],
): { general: PortalThread[]; projects: ThreadGroup[] } {
  const byRecent = (a: PortalThread, b: PortalThread) => String(b.lastMessageAt ?? b.createdAt).localeCompare(String(a.lastMessageAt ?? a.createdAt));
  const isGeneral = (t: PortalThread) => t.general || t.projectId === null;
  const general = threads.filter((t) => isGeneral(t) && generalClientIds.includes(t.clientId)).sort(byRecent);
  const map = new Map<string, ThreadGroup>();
  for (const t of [...threads].sort(byRecent)) {
    if (isGeneral(t)) continue;
    const key = t.projectId as string;
    const g = map.get(key) ?? { key, title: t.projectName ?? "Project", threads: [] };
    g.threads.push(t);
    map.set(key, g);
  }
  return { general, projects: [...map.values()] };
}

/** The clients a "start in General" may name: the ones in `generalClientIds`, with names from the profile. A client the
 *  profile does not name keeps a neutral label (the server still resolves it). Empty = General is not offered at all. */
export function generalClientChoices(
  generalClientIds: readonly string[],
  clients: ReadonlyArray<{ id: string; name: string }>,
): PortalClientChoice[] {
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return generalClientIds.map((id) => ({ id, name: names.get(id) ?? "Your account" }));
}

/** The name a thread goes by in a list: its subject, else "General" (with the client's name when the contact has
 *  more than one client) or the project's name. */
export function threadTitle(t: Pick<PortalThread, "subject" | "general" | "projectName" | "clientName">, multiClient = false): string {
  if (t.subject && t.subject.trim()) return t.subject;
  if (t.general) return multiClient && t.clientName ? `General: ${t.clientName}` : "General";
  return t.projectName ?? "Conversation";
}
