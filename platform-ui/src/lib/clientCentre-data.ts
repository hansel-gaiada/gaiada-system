import "server-only";
// Client Centre — READERS. Thin `platformFetch` calls over the six endpoints in the plan
// (`docs/plans/2026-09-29-client-centre.md` §API contract; `docs/FRONTEND-BFF-CONTRACT.md` §23 once
// the backend agent adds it). Types + pure helpers live in `./clientCentre.ts` (client-safe);
// writes in `./clientCentreActions.ts`.
//
// DEGRADE RULE: a 404 on a single-client GET means "no such client in this tenant" (staff) or
// "not yours / doesn't exist" (portal — the plan is explicit that the portal route answers 404 for
// out-of-scope, never 403) — both become `null` and the caller 404s the page. Everything else
// (500, network) is left to THROW into the route's error boundary: a profile page that renders
// empty on a backend outage would tell staff or a client that nothing has been configured yet,
// which is the wrong kind of wrong here (same reasoning as `clientHub.ts`'s `getClientOverview`).
import { platformFetch, PlatformError } from "./platform";
import type { CentreListItem, CentreProfile, PortalCentreListItem } from "./clientCentre";

export async function listClientCentres(userId: string, tenant: string): Promise<CentreListItem[]> {
  return platformFetch<CentreListItem[]>(`/api/${tenant}/clients/centre`, userId);
}

export async function getClientCentre(userId: string, tenant: string, clientId: string): Promise<CentreProfile | null> {
  try {
    return await platformFetch<CentreProfile>(`/api/${tenant}/clients/${clientId}/centre`, userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}

export async function listPortalCentres(userId: string, tenant: string): Promise<PortalCentreListItem[]> {
  return platformFetch<PortalCentreListItem[]>(`/api/${tenant}/portal/centre`, userId);
}

export async function getPortalCentre(userId: string, tenant: string, clientId: string): Promise<CentreProfile | null> {
  try {
    return await platformFetch<CentreProfile>(`/api/${tenant}/portal/centre/${clientId}`, userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}
