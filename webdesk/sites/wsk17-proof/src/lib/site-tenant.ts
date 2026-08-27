// webdesk/sites/wsk17-proof/src/lib/site-tenant.ts
//
// WSK-17 -- single source of truth for this site's own tenant slug + collection key. Declared
// `as const` so the template-literal path strings built from them (e.g. in src/pages/**) resolve
// to the exact literal keys the generated `paths` type (src/sdk/sdk.d.ts) declares -- a typo here
// or in a page is a compile error under `npm run conformance:compile`, not a silent 404.
//
// scripts/seed-and-generate.sh creates a tenant with EXACTLY this slug and this collection key
// before running codegen, so these two constants and the generated SDK always agree by
// construction (not by convention).
export const TENANT_SLUG = 'wsk17-proof' as const
export const COLLECTION_KEY = 'case-study' as const
