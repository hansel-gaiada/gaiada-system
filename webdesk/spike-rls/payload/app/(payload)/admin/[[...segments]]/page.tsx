import type { Metadata } from 'next'

import config from '@payload-config'
import { generatePageMetadata, RootPage } from '@payloadcms/next/views'
import { headers as getHeaders, cookies as getCookies } from 'next/headers'

// @ts-expect-error - plain .mjs, no types authored for this spike file
import { runWithTenant } from '../../../../src/tenant-context.mjs'
import { importMap } from '../importMap.js'

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

// P10 - the admin SSR shell (dashboard / list view initial render) is OUR
// file, same as the REST route: we resolve the tenant from the incoming
// request (cookie, mirroring what a real logged-in admin session would
// carry) and wrap the ENTIRE RootPage render - including whatever Local API
// calls it issues server-side - inside tenantStore.run(). Interactive
// admin-panel actions (list search/paginate/save) happen via client-side
// fetches to /api/<collection>, i.e. the SAME route.ts this file's sibling
// wraps - so this page only needs to cover the initial SSR paint.
//
// FINDING (see FINDINGS.md P10): this wrapping is necessary but NOT
// sufficient. tenantStore.getStore() reads correctly at every point in THIS
// file's own execution (proven via diagnostic instrumentation during
// investigation), yet the actual pool RootPage's data load queries against
// never observes it - strong evidence that Next's Route Handler layer
// (route.ts) and this Page/RSC layer end up with SEPARATE instantiations of
// the tenant-pg.mjs/tenant-pool.mjs module graph, and only whichever layer
// first triggers the shared Payload/pool singleton's construction has its
// runWithTenant() writes actually seen by that pool's checkout hook. This is
// left AS-IS (not patched) because the only fix available from here would
// mean editing the frozen layer-1 file src/tenant-pool.mjs (out of this
// ticket's scope) to anchor the AsyncLocalStorage on globalThis - exactly
// the kind of workaround the exit criterion says to report as evidence
// for, not invent mid-ticket.
const Page = async ({ params, searchParams }: Args) => {
  const cookieStore = await getCookies()
  const hdrs = await getHeaders()
  const tenantId = cookieStore.get('webdesk_tenant')?.value ?? hdrs.get('x-webdesk-tenant') ?? null

  return runWithTenant(tenantId, () => RootPage({ config, importMap, params, searchParams }))
}

export default Page
