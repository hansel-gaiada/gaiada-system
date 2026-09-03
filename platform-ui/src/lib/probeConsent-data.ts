import "server-only";
import { platformFetch, PlatformError } from "./platform";
import { pendingConsentRequests, PROBE_CONSENT_WORKFLOW, type PendingConsentRequest } from "./probeConsent";

// Server-side read for open probe-consent requests.
//
// ── WHY THE PER-TENANT LIST AND NOT `lib/approvals.ts`'s `listApprovals` ──────────────────────
// That reader hits the unified cross-tenant `/api/approvals` surface, whose `UnifiedApprovalItem`
// is a summary shape for the inbox — it does not carry `tool_args`, and `tool_args.propertyId` is
// the ONLY thing that ties a request to a site. So this uses the per-tenant list
// (`GET /api/:t/automation-approvals`), which returns the column, and filters by workflow.
//
// ── ONE READ FOR THE WHOLE TABLE ──────────────────────────────────────────────────────────────
// Fetched once per page and joined in memory against 81 rows, not asked per site. Same shaping
// decision as the monitor bridge, and for the same reason: the alternative is one round trip per
// row to answer a question about a handful of them.

export type ConsentRequestsResult =
  | { available: true; pending: PendingConsentRequest[] }
  /** The approvals surface could not be read. NOT the same as "nothing is pending": rendering a
   *  "Request consent" button to someone whose open request we simply could not see would invite a
   *  duplicate the server then refuses with a confusing conflict. */
  | { available: false; reason: "not_enabled" | "refused" };

interface RawRow {
  id: string;
  workflow_id?: string;
  workflowId?: string;
  status?: string;
  tool_args?: unknown;
  toolArgs?: unknown;
  requested_by?: string | null;
  requestedBy?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
}

/** The list endpoint's own SELECT is snake_case and its serialiser has changed shape before, so
 *  both spellings are accepted per field. This is the "frontend-first drift" trap this component's
 *  guide names as its recurring bug class: a field read under the wrong name is silently undefined,
 *  and here that would mean a pending request rendering as "no request". */
function normalise(rows: RawRow[]) {
  return rows.map((r) => ({
    id: r.id,
    workflowId: r.workflowId ?? r.workflow_id ?? "",
    status: r.status,
    toolArgs: r.toolArgs ?? r.tool_args,
    requestedBy: r.requestedBy ?? r.requested_by ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
  }));
}

export async function fetchPendingConsentRequests(userId: string, tenant: string): Promise<ConsentRequestsResult> {
  try {
    const raw = await platformFetch<unknown>(
      `/api/${tenant}/automation-approvals?status=pending&origin=search`,
      userId,
    );
    const rows = Array.isArray(raw)
      ? (raw as RawRow[])
      : Array.isArray((raw as { items?: unknown })?.items)
        ? ((raw as { items: RawRow[] }).items)
        : null;
    // A 200 carrying the wrong SHAPE is the dangerous case — an array is truthy and a bare object
    // would sail into `.map()`. Treat it as "could not ask", not as an empty queue.
    if (!rows) return { available: false, reason: "not_enabled" };
    return { available: true, pending: pendingConsentRequests(normalise(rows)) };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { available: false, reason: "refused" };
    if (e instanceof PlatformError && (e.status === 404 || e.status === 405)) return { available: false, reason: "not_enabled" };
    throw e;
  }
}

export { PROBE_CONSENT_WORKFLOW };
