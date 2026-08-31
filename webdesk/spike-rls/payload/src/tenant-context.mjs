/**
 * Tenant resolution for the paths WE author (REST/admin route wrappers, job
 * handlers). Real production resolution would come from a validated route
 * param / authenticated session scope, never a raw client-supplied header -
 * this spike stands in a cookie (what the admin UI's own browser session
 * would carry) and a header (what a service caller would carry) because the
 * point under test is whether the GUC propagates once established, not
 * tenant-resolution policy.
 */
import { tenantStore } from './tenant-pg.mjs';

export const COOKIE_NAME = 'webdesk_tenant';
export const HEADER_NAME = 'x-webdesk-tenant';

/** Accepts a standard web Request/NextRequest. */
export function resolveTenantId(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)webdesk_tenant=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  const header = request.headers.get(HEADER_NAME);
  if (header) return header;
  return null;
}

export function runWithTenant(tenantId, fn) {
  return tenantStore.run(tenantId, fn);
}

export { tenantStore };
