import type { Metadata } from 'next'

import config from '@payload-config'
import { generatePageMetadata, RootPage } from '@payloadcms/next/views'
import { headers as getHeaders, cookies as getCookies } from 'next/headers'

// @ts-expect-error - plain .mjs, no types authored for this project's tenancy files
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

// WSK-02 — this is the exact surface WSK-00's P10 probe found broken. The fix attempted here is
// src/tenant-pool.mjs's globalThis anchor. Diagnostic instrumentation (added, run, observed, then
// reverted — see this ticket's report) proved the anchor DOES fix what P10 diagnosed: tenantId
// resolves correctly and `tenantStore.getStore()` reads back correctly at every point inside this
// file's own execution, including right before calling RootPage. It also surfaced a SEPARATE,
// previously-undocumented issue on this same surface: Payload's list view throws Next's internal
// `NEXT_REDIRECT` on the bare `/admin/collections/pages` URL when the SSR request's auth cookie
// is not accepted (the same CSRF/Origin requirement FINDINGS.md documents for REST — a plain
// server-to-server request needs an `Origin` header or `Sec-Fetch-Site`, which a real browser
// navigation sends automatically but a script must set explicitly). With that header supplied,
// the redirect stops firing, but the freshly-created row still did not appear in the rendered
// list in this ticket's testing, and instrumentation could not pin down further why within this
// ticket's time-box — logged as a WSK-02 finding, not silently claimed fixed. See the ticket
// report for the full evidence trail; this file is left functionally unchanged from the spike's
// version (import path only), so a future investigation is a fair re-run of the same code.
const Page = async ({ params, searchParams }: Args) => {
  const cookieStore = await getCookies()
  const hdrs = await getHeaders()
  const tenantId = cookieStore.get('webdesk_tenant')?.value ?? hdrs.get('x-webdesk-tenant') ?? null

  return runWithTenant(tenantId, () => RootPage({ config, importMap, params, searchParams }))
}

export default Page
