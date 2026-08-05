import "server-only";
// WSUX-6 (UX-2 §2, contract §9a) — thin BFF wrapper over the unified approvals
// read (`GET /api/approvals`, WSUX-1) that backs the /approvals inbox. This is
// the ONLY new approvals reader this ticket introduces: it does not touch
// `getPendingApprovals`/`getDecidedApprovals` in lib/data.ts (those still back
// `lib/queue.ts`'s client-side merge for the Home queue — WSUX-7 owns
// repointing that onto this same endpoint per plan R-3; forking that here
// would be scope creep on a ticket that isn't mine).
import { platformFetch, PlatformError } from "./platform";
import { normalizeEnvelope, type Envelope } from "./envelope";
import {
  ORIGINS, ORIGIN_LABEL, originCounts, isApprovalOrigin, formatAge,
  type ApprovalOrigin, type ApprovalStatus, type ApprovalSort, type UnifiedApprovalItem,
} from "./approvalsShared";

// Re-exported so server-component callers (the /approvals page) have one
// import path; client components import from "./approvalsShared" directly to
// avoid pulling this "server-only" module into the browser bundle.
export { ORIGINS, ORIGIN_LABEL, originCounts, isApprovalOrigin, formatAge };
export type { ApprovalOrigin, ApprovalStatus, ApprovalSort, UnifiedApprovalItem };

export interface ListApprovalsOptions {
  scope?: "all" | string;
  status?: ApprovalStatus;
  sort?: ApprovalSort;
}

export interface ApprovalsResult {
  envelope: Envelope<UnifiedApprovalItem>;
  /** True when the unified endpoint itself couldn't be reached at all (vs. a
   *  per-tenant leg being excluded, which the envelope already reports) — UX-2
   *  §2.3 "never blank the page", surfaced as its own banner distinct from the
   *  scope-exclusion envelope. */
  unavailable: boolean;
}

// APPR-01 — the `/approvals/[id]` detail page's reads. Mirrors `core/automation-approvals.
// controller.ts`'s `detail()` and `modules/agency/agency.controller.ts`'s `approvalDetail()`
// exactly (both new, this same ticket) — field names are camelCase on both ends by construction.
export interface AutomationApprovalDetail {
  id: string;
  workflowId: string;
  toolName: string;
  toolArgs: unknown;
  impact: string;
  reason: string | null;
  status: string;
  origin: "automation" | "agent" | "hr";
  agentName: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  executionStatus: string | null;
  executedAt: string | null;
  executedBy: string | null;
  executionError: string | null;
  executionResult: unknown;
  executionAttempts: number | null;
}

export interface AgencyApprovalDetail {
  id: string;
  subject: string;
  campaignId: string;
  campaign: string;
  assetId: string | null;
  status: string;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export type ApprovalDetail =
  | { kind: "automation_approval"; origin: "automation" | "agent" | "hr"; data: AutomationApprovalDetail }
  | { kind: "agency_approval"; origin: "agency"; data: AgencyApprovalDetail };

// `isRowShaped` guards against DEMO_MODE's catch-all GET fallback (`demoFixtures.ts`'s final
// `if (m === "GET") return ok([]);`) — an unmatched path 200s with an empty ARRAY, which is
// truthy in JS. Without this guard a demo id with no fixture would be treated as "found" with
// every field undefined instead of falling through to the null/404 branch, which is exactly the
// class of bug CLAUDE.md's "frontend-first drift" trap warns about (a confident wrong render,
// nothing throws). Real platform-nest responses never take this shape — `detail()`/
// `approvalDetail()` return the row object or throw 404 — so this is pure demo-mode defense.
function isRowShaped(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function getAutomationApprovalDetail(userId: string, tenantId: string, id: string): Promise<AutomationApprovalDetail | null> {
  try {
    const data = await platformFetch<unknown>(`/api/${tenantId}/automation-approvals/${id}`, userId);
    return isRowShaped(data) ? (data as unknown as AutomationApprovalDetail) : null;
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}

async function getAgencyApprovalDetail(userId: string, tenantId: string, id: string): Promise<AgencyApprovalDetail | null> {
  try {
    const data = await platformFetch<unknown>(`/api/${tenantId}/modules/agency/approvals/${id}`, userId);
    return isRowShaped(data) ? (data as unknown as AgencyApprovalDetail) : null;
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}

/** The `/approvals/[id]` route carries only an id — no `?kind=` (the emitted `payload.href` and
 *  `entityHref()` both intentionally omit it, since a client-controlled query param would just be
 *  another thing a hand-edited URL could get wrong). Automation is tried first: its `detail()`
 *  fetches the row BEFORE authorizing, so a 404 there is a genuine "not an automation_approval in
 *  this tenant" — safe to fall through to the agency lookup. Either leg's 403 is a REAL refusal
 *  (the row exists and this caller may not read it) and propagates immediately, never swallowed
 *  into "try the other kind" — that would risk misreporting a real approval as not-found. */
export async function getApprovalDetail(userId: string, tenantId: string, id: string): Promise<ApprovalDetail | null> {
  const automation = await getAutomationApprovalDetail(userId, tenantId, id);
  if (automation) return { kind: "automation_approval", origin: automation.origin, data: automation };
  const agency = await getAgencyApprovalDetail(userId, tenantId, id);
  if (agency) return { kind: "agency_approval", origin: "agency", data: agency };
  return null;
}

// Always fetches every origin server-side (no `origin` query param) — the
// inbox needs full cross-origin counts for its facet chips regardless of
// which chip is currently selected, so origin filtering happens client-side
// over one fetched set rather than refetching per chip (UX-2 §2.1/§2.2).
export async function listApprovals(userId: string, opts: ListApprovalsOptions = {}): Promise<ApprovalsResult> {
  const p = new URLSearchParams();
  p.set("scope", opts.scope ?? "all");
  p.set("status", opts.status ?? "pending");
  p.set("sort", opts.sort ?? "urgency");
  try {
    const raw = await platformFetch<unknown>(`/api/approvals?${p.toString()}`, userId);
    return { envelope: normalizeEnvelope<UnifiedApprovalItem>(raw), unavailable: false };
  } catch (e) {
    // A 404 (route not deployed yet) or any transport failure degrades to an
    // empty, explicitly-flagged result — never throws into the page.
    void (e instanceof PlatformError ? e.status : 0);
    return { envelope: { items: [], companies: [] }, unavailable: true };
  }
}
