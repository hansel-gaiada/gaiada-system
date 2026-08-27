import config from '@payload-config'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'

import { resolveTenantId, runWithTenant } from '../../../../src/tenant-context.mjs'

// WSK-02 — Payload's generic, unscoped collection REST (proven correct for the GUC by WSK-00's
// P9, 9/9). This file is INTERNAL-LISTENER ONLY: it is what app/(payload)/api/[...slug]/route.ts
// mounts under Next's default `/api` prefix, and the public gateway (src/public-gateway.mjs) has
// a hardcoded, unconditional denylist entry for `^/api(/|$)` — this route is never reachable
// through the public listener regardless of what runs here.
const wrap = (build: (config: any) => (request: Request, args: any) => Promise<Response>) => {
  const handler = build(config)
  return (request: Request, args: any) => {
    const tenantId = resolveTenantId(request)
    return runWithTenant(tenantId, () => handler(request, args))
  }
}

export const GET = wrap(REST_GET)
export const POST = wrap(REST_POST)
export const DELETE = wrap(REST_DELETE)
export const PATCH = wrap(REST_PATCH)
export const PUT = wrap(REST_PUT)
export const OPTIONS = wrap(REST_OPTIONS)
