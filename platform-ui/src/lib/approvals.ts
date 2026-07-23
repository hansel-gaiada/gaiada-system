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
