import "server-only";
// MI-05 — thin readers over the MI-03 staff endpoints (webdev-change-requests.controller.ts).
// Same degrade convention as lib/pipeline.ts's `safe()`: a 404/403 (module not enabled, tenant on
// an older tag, or Cerbos denying a non-manager reader) falls back to []/null rather than crashing
// the tab — the RBAC denial itself is what MI-05's negative control asserts (an empty/absent read,
// not a thrown error reaching the page).
import { platformFetch, PlatformError } from "./platform";
import type { ChangeRequestDetail, ChangeRequestRow } from "./webdevChangeRequests";

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export async function listChangeRequests(
  userId: string,
  tenant: string,
  opts: { status?: string; clientId?: string; projectId?: string; kind?: string } = {},
): Promise<ChangeRequestRow[]> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  if (opts.kind) q.set("kind", opts.kind);
  const qs = q.toString();
  return safe(
    platformFetch<ChangeRequestRow[]>(`/api/${tenant}/webdev/change-requests${qs ? `?${qs}` : ""}`, userId),
    [],
  );
}

export async function getChangeRequest(
  userId: string,
  tenant: string,
  id: string,
): Promise<ChangeRequestDetail | null> {
  return safe(platformFetch<ChangeRequestDetail>(`/api/${tenant}/webdev/change-requests/${id}`, userId), null);
}
