import config from '@payload-config'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'

// @ts-expect-error - plain .mjs, no types authored for this spike file
import { resolveTenantId, runWithTenant } from '../../../../src/tenant-context.mjs'

// P9 - the REST surface. This file is OURS, not Payload's internals: every
// handler is wrapped so the tenant resolved from the request (cookie or
// header - see tenant-context.mjs) is the ALS value in scope for every query
// Payload's REST handler issues underneath, whether or not that particular
// operation happens to run inside a transaction.
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
