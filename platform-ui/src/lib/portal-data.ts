import "server-only";
// Client portal — READERS. Thin `platformFetch` calls over the portal BFF (portal*.controller.ts).
// Types + pure helpers live in `./portal.ts` (client-safe); writes in `./portalActions.ts`.
//
// AUTH: a client authenticates against the SAME `gaiada` realm as staff and holds only the `client`
// role. Ownership resolves server-side through `client_contacts` UNIONed with the legacy
// `clients.portal_user_id` (see platform-nest src/core/portal-scope.ts). Nothing here re-implements or
// second-guesses that — every function below is a fetch plus a degrade rule.
//
// ── THE DEGRADE RULE, AND WHY 403 AND 404 ARE TREATED DIFFERENTLY ─────────────────────────────────
// The BFF answers 403 "not a portal client" for anyone who is not a contact — i.e. every staff member
// — and 404 for a real client asking about something that is not theirs. Collapsing both into `[]`
// made the old portal tell staff "once your kickoff is processed, your project appears here", as
// though a client project were on its way to them. So 403 is carried as a FLAG (`isPortalClient:
// false`) wherever a page needs to explain itself, and 404/empty degrades to a null/empty value.
//
// Anything else (500, a network failure) is deliberately allowed to THROW into the route's error
// boundary. A backend outage rendering as an empty dashboard is the worst outcome available here: the
// client concludes their project has no milestones, no invoices and no contract.
import { platformFetch, PlatformError } from "./platform";
import type {
  PortalChangeRequest, PortalContract, PortalContractDetail, PortalDeliverable, PortalInvoice,
  PortalInvoiceDetail, PortalMilestone, PortalOverview, PortalProfile, PortalProject, PortalProjectDetail,
  PortalRun, PortalRunDetail, PortalSocialReview, PortalTimelineEvent,
} from "./portal";

/** Degrade "not found"/"not yours" to a fallback; let everything else propagate. NOT extended to 403:
 *  a 403 on a route a client legitimately reaches means their access was revoked mid-session, and
 *  silently showing an empty page would hide that. Callers that need to distinguish it use `probe`. */
async function safe<T>(p: Promise<T>, fb: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return fb;
    // 403 included here for LIST routes only (see callers): a staff member browsing /portal must get
    // the teach-state rather than a crash.
    if (e instanceof PlatformError && e.status === 403) return fb;
    throw e;
  }
}

/** The landing payload. Returns `isPortalClient: false` on the BFF's 403 so the page can explain that
 *  the viewer is staff rather than implying a client project is pending for them. */
export async function getPortalOverview(
  userId: string,
  tenant: string,
): Promise<{ overview: PortalOverview | null; isPortalClient: boolean }> {
  try {
    return { overview: await platformFetch<PortalOverview>(`/api/${tenant}/portal/overview`, userId), isPortalClient: true };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { overview: null, isPortalClient: false };
    // A 404 here means the endpoint itself is absent — a platform running an older tag than this UI.
    // Reported as "client, but nothing to show" so the portal still renders its shell and its
    // BackendPending note rather than 500ing on a version skew.
    if (e instanceof PlatformError && e.status === 404) return { overview: null, isPortalClient: true };
    throw e;
  }
}

export async function listPortalProjects(userId: string, tenant: string): Promise<PortalProject[]> {
  return safe(platformFetch<PortalProject[]>(`/api/${tenant}/portal/projects`, userId), []);
}

export async function getPortalProject(userId: string, tenant: string, projectId: string): Promise<PortalProjectDetail | null> {
  return safe(platformFetch<PortalProjectDetail>(`/api/${tenant}/portal/projects/${projectId}`, userId), null);
}

export async function listPortalMilestones(userId: string, tenant: string): Promise<PortalMilestone[]> {
  return safe(platformFetch<PortalMilestone[]>(`/api/${tenant}/portal/milestones`, userId), []);
}

export async function getPortalTimeline(userId: string, tenant: string, limit = 120): Promise<PortalTimelineEvent[]> {
  return safe(platformFetch<PortalTimelineEvent[]>(`/api/${tenant}/portal/timeline?limit=${limit}`, userId), []);
}

export async function listPortalDeliverables(
  userId: string,
  tenant: string,
  projectId?: string,
): Promise<PortalDeliverable[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return safe(platformFetch<PortalDeliverable[]>(`/api/${tenant}/portal/deliverables${qs}`, userId), []);
}

export async function listPortalInvoices(userId: string, tenant: string): Promise<PortalInvoice[]> {
  return safe(platformFetch<PortalInvoice[]>(`/api/${tenant}/portal/invoices`, userId), []);
}

export async function getPortalInvoice(userId: string, tenant: string, invoiceId: string): Promise<PortalInvoiceDetail | null> {
  return safe(platformFetch<PortalInvoiceDetail>(`/api/${tenant}/portal/invoices/${invoiceId}`, userId), null);
}

export async function listPortalContracts(userId: string, tenant: string): Promise<PortalContract[]> {
  return safe(platformFetch<PortalContract[]>(`/api/${tenant}/portal/contracts`, userId), []);
}

export async function getPortalContract(userId: string, tenant: string, contractId: string): Promise<PortalContractDetail | null> {
  return safe(platformFetch<PortalContractDetail>(`/api/${tenant}/portal/contracts/${contractId}`, userId), null);
}

export async function getPortalProfile(userId: string, tenant: string): Promise<PortalProfile | null> {
  return safe(platformFetch<PortalProfile>(`/api/${tenant}/portal/profile`, userId), null);
}

// ── Runs / approvals (WS11, kept unchanged in behaviour) ──────────────────────────────────────────

/** The caller's delivery runs, plus WHY the list is empty when it is. */
export async function listPortalRuns(
  userId: string,
  tenant: string,
): Promise<{ runs: PortalRun[]; isPortalClient: boolean }> {
  try {
    return { runs: await platformFetch<PortalRun[]>(`/api/${tenant}/portal/runs`, userId), isPortalClient: true };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { runs: [], isPortalClient: false };
    if (e instanceof PlatformError && e.status === 404) return { runs: [], isPortalClient: true };
    throw e;
  }
}

export async function getPortalRun(userId: string, tenant: string, runId: string): Promise<PortalRunDetail | null> {
  return safe(platformFetch<PortalRunDetail>(`/api/${tenant}/portal/runs/${runId}`, userId), null);
}

// ── MI-04: maintenance intake (webdev change requests) ─────────────────────────────────────────────

/** The caller's own change requests (own clients, own project scope — `resolvePortalScope` on the
 *  backend, never re-derived here), plus WHY the list is empty when it is, same shape as
 *  `listPortalRuns` — a staff member browsing `/portal/requests` must get the teach-state, not a
 *  silently empty list that reads as "no client has ever asked us anything". */
export async function listPortalChangeRequests(
  userId: string,
  tenant: string,
): Promise<{ requests: PortalChangeRequest[]; isPortalClient: boolean }> {
  try {
    return {
      requests: await platformFetch<PortalChangeRequest[]>(`/api/${tenant}/portal/change-requests`, userId),
      isPortalClient: true,
    };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { requests: [], isPortalClient: false };
    if (e instanceof PlatformError && e.status === 404) return { requests: [], isPortalClient: true };
    throw e;
  }
}

export async function getPortalChangeRequest(
  userId: string,
  tenant: string,
  id: string,
): Promise<PortalChangeRequest | null> {
  return safe(platformFetch<PortalChangeRequest>(`/api/${tenant}/portal/change-requests/${id}`, userId), null);
}

// ── SMM-31/32: social post client-review (D-16) ────────────────────────────────────────────────────

/** The caller's own social-post reviews (own client's, via `resolvePortalScope` — never re-derived
 *  here), plus WHY the list is empty when it is — same shape as `listPortalRuns`/
 *  `listPortalChangeRequests` above, so a staff member browsing `/portal/social-reviews` gets the
 *  teach-state rather than a silently empty list that reads as "no client has ever been asked to
 *  review a post." `status` is optional and forwarded verbatim (the BFF's own `?status=` filter). */
export async function listPortalSocialReviews(
  userId: string,
  tenant: string,
  status?: string,
): Promise<{ reviews: PortalSocialReview[]; isPortalClient: boolean }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  try {
    return {
      reviews: await platformFetch<PortalSocialReview[]>(`/api/${tenant}/portal/social-reviews${qs}`, userId),
      isPortalClient: true,
    };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { reviews: [], isPortalClient: false };
    if (e instanceof PlatformError && e.status === 404) return { reviews: [], isPortalClient: true };
    throw e;
  }
}

/** One review, by id. The BFF has no dedicated single-review GET (§16h's own contract: list + decide
 *  only, same minimal surface `PortalController.decideGate`'s own kind uses elsewhere) — the list is
 *  capped at 200 and scoped to the caller's own clients already, so finding one row in it is the
 *  correct read rather than inventing an endpoint the backend does not have. Returns `null` for an
 *  id outside the caller's own scope, identical in shape to a 404 on every other portal detail
 *  read — never distinguishing "not yours" from "does not exist" (0075's rule, restated in §16h). */
export async function getPortalSocialReview(
  userId: string,
  tenant: string,
  id: string,
): Promise<PortalSocialReview | null> {
  const { reviews } = await listPortalSocialReviews(userId, tenant);
  return reviews.find((r) => r.id === id) ?? null;
}
