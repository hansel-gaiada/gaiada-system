import "server-only";
// Client Centre — READERS. Thin `platformFetch` calls over the six endpoints in the plan
// (`docs/plans/2026-09-29-client-centre.md` §API contract; `docs/FRONTEND-BFF-CONTRACT.md` §25 —
// landed as §25, not the plan's own §23, because that number was already taken by the LMS module).
// Types + pure helpers live in `./clientCentre.ts` (client-safe); writes in `./clientCentreActions.ts`.
//
// DEGRADE RULE: a 404 on a single-client GET means "no such client in this tenant" (staff) or
// "not yours / doesn't exist" (portal — the plan is explicit that the portal route answers 404 for
// out-of-scope, never 403) — both become `null` and the caller 404s the page. Everything else
// (500, network) is left to THROW into the route's error boundary: a profile page that renders
// empty on a backend outage would tell staff or a client that nothing has been configured yet,
// which is the wrong kind of wrong here (same reasoning as `clientHub.ts`'s `getClientOverview`).
//
// The staff LIST is the one exception: it is `ModuleEnabledGuard("clients")`-gated
// (`clients-centre.controller.ts`), so a tenant that hasn't turned the `clients` module on gets a
// plain 404 there — mirrors `entities.ts`'s own `listClients`/`skipUnavailable` precedent (404/403
// degrades to an empty list, never a crash for an ordinary module-off tenant).
import { platformFetch, PlatformError } from "./platform";
import type { BusinessResults, CentreListItem, CentreProfile, PortalCentreListItem } from "./clientCentre";

export async function listClientCentres(userId: string, tenant: string): Promise<CentreListItem[]> {
  try {
    return await platformFetch<CentreListItem[]>(`/api/${tenant}/clients/centre`, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
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

// PV6-03 — Services & results. DEGRADE RULE (the opposite of the profile readers): a failed read returns `null`,
// and the view says "Some results could not be loaded", because a results part that throws would take the whole
// Business workspace down with it, while one that rendered empty would claim "we run no service here". `null`
// is never an empty list.
export async function getClientCentreResults(userId: string, tenant: string, clientId: string): Promise<BusinessResults | null> {
  try {
    return await platformFetch<BusinessResults>(`/api/${tenant}/clients/${clientId}/centre/results`, userId);
  } catch {
    return null;
  }
}

export async function getPortalCentreResults(userId: string, tenant: string, clientId: string): Promise<BusinessResults | null> {
  try {
    return await platformFetch<BusinessResults>(`/api/${tenant}/portal/centre/${clientId}/results`, userId);
  } catch {
    return null;
  }
}
