/**
 * Tenant resolution for the paths this project authors (REST route wrapper, admin SSR page
 * wrapper). Ported from the WSK-00 spike unchanged in shape.
 *
 * Real production resolution belongs to WSK-04/05: a validated route param, an authenticated
 * session's own scope, or an api_keys lookup — never a raw client-supplied header taken at face
 * value. This file still reads a cookie/header directly, same as the spike, because WSK-02's job
 * is proving the GUC propagates once established (the pool mechanism), not tenant-resolution
 * policy — that hardening is explicitly WSK-04/05's scope, not re-litigated here.
 */
import { tenantStore } from './tenant-pool.mjs'

export const COOKIE_NAME = 'webdesk_tenant'
export const HEADER_NAME = 'x-webdesk-tenant'

/** Accepts a standard web Request/NextRequest. */
export function resolveTenantId(request) {
  const cookieHeader = request.headers.get('cookie') || ''
  const match = cookieHeader.match(/(?:^|;\s*)webdesk_tenant=([^;]+)/)
  if (match) return decodeURIComponent(match[1])
  const header = request.headers.get(HEADER_NAME)
  if (header) return header
  return null
}

export function runWithTenant(tenantId, fn) {
  return tenantStore.run(tenantId, fn)
}

export { tenantStore }
