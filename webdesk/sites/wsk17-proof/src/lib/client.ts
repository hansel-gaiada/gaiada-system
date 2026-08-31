// webdesk/sites/wsk17-proof/src/lib/client.ts
//
// WSK-17 -- the ONE place this site touches the network. Deliberately generic: `createClient`
// (openapi-fetch) is a type-driven dispatcher parameterised entirely by the generated `paths`
// type from ../sdk/sdk.d.ts (produced by webdesk/api/src/codegen/generator/generate-single.mts
// against this site's own tenant, see scripts/seed-and-generate.sh). This file contains no route
// string, no path template, no query-param name -- every one of those is supplied by the caller
// through `paths`, which is generated, not hand-written. See README.md's "why openapi-fetch"
// section for why this is the honest way to satisfy "purely from the generated SDK" given that
// WSK-15's codegen output is types-only (a finding, not a workaround invented here).
import createClient from 'openapi-fetch'
import type { paths } from '../sdk/sdk.d.ts'

const baseUrl = process.env.WEBDESK_V1_BASE_URL
const apiKey = process.env.WEBDESK_API_KEY

if (!baseUrl) throw new Error('[wsk17-proof] WEBDESK_V1_BASE_URL is not set')
if (!apiKey) throw new Error('[wsk17-proof] WEBDESK_API_KEY is not set')

export const client = createClient<paths>({
  baseUrl,
  headers: { authorization: `Bearer ${apiKey}` },
})
