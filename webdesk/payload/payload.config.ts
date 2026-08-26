// WSK-02 — the real Payload 3 service config for Zone B (webdesk). Ported mechanism from the
// WSK-00 spike (webdesk/spike-rls/payload/payload.config.ts); NOT that file, and not a copy of
// it verbatim — see src/tenant-pool.mjs for the one deliberate change (globalThis-anchored ALS).
//
// Scope note (per this ticket): ONE minimal collection ("pages") carrying tenant_id, just enough
// to prove the boot end-to-end. Vocabulary v1 (8 primitives / 9 block types) and the frozen `/v1`
// envelope are WSK-06's job — not built here.
import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
// @ts-expect-error - plain .mjs, no types authored for this project's tenancy files
import { tenantAwarePg } from './src/tenant-pg.mjs'
// WSK-04b (WSK-D25) — the app-layer tenant predicate, independent of the `webdesk.tenant_ctx`
// GUC `tenant-pg.mjs` stamps on the pool. See src/tenant-access.mjs's header for why this is a
// SEPARATE mechanism (reads tenantStore directly, never touches Postgres) and why it does not
// weaken the overrideAccess:true callers (setup-schema.mjs, future seeding) rely on.
// @ts-expect-error - plain .mjs, no types authored for this project's tenancy files
import { tenantScopedAccess } from './src/tenant-access.mjs'
// WSK-06 — the vocabulary v1 package (8 primitives, 9 block types), consumed here so
// payload.config.ts is one of the "config" surfaces the design says the vocabulary feeds
// (webdesk-design.md §05 Layer 1: "consumed by Payload config, codegen, and the block-renderer
// library"). This is metadata only (`config.custom`) — it does not register Payload-native
// collections for content; the real /v1 read path (collections/router.ts) queries the generic
// collections/content_items schema directly. See this ticket's final report for why.
import { VOCABULARY_SUMMARY } from './vocabulary/version.ts'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Dev-push safety (FINDINGS.md addendum, reproduced twice): an ORDINARY dev boot with just
// PAYLOAD_ALLOW_PUSH=true disables row security on every table Payload touches and DROPS the
// tenant_isolation policy, while leaving relforcerowsecurity=true — fail-OPEN, and invisible to
// any check that only inspects the FORCE flag. Requiring a SECOND, deliberately loud/ugly-named
// flag in addition to PAYLOAD_ALLOW_PUSH means the exact env var combination FINDINGS.md flags as
// "an ordinary dev boot" (PAYLOAD_ALLOW_PUSH=true alone) is no longer sufficient by itself to
// disable RLS — and gating on NODE_ENV as well means push can never fire in a config that isn't
// explicitly development, whatever else is set.
const pushRequested = process.env.PAYLOAD_ALLOW_PUSH === 'true'
const pushAcknowledged = process.env.PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS === 'true'
const isDev = process.env.NODE_ENV !== 'production'
const pushEnabled = isDev && pushRequested && pushAcknowledged

if (pushRequested && !pushAcknowledged) {
  console.warn(
    '[webdesk-payload] PAYLOAD_ALLOW_PUSH=true was set WITHOUT ' +
      'PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS=true — push stays DISABLED. ' +
      'See README.md "Dev-push safety" before setting the second flag.',
  )
}
if (pushEnabled) {
  console.warn('!'.repeat(78))
  console.warn('[webdesk-payload] SCHEMA PUSH IS ENABLED FOR THIS BOOT.')
  console.warn('This DISABLES row-level security (relrowsecurity=false) and DROPS the')
  console.warn('tenant_isolation policy on every table Payload touches, even though')
  console.warn('relforcerowsecurity stays true and LOOKS protected. See FINDINGS.md and')
  console.warn('README.md "Dev-push safety". You MUST re-run `npm run setup-schema`')
  console.warn('immediately after this boot to restore FORCE RLS + the policy.')
  console.warn('!'.repeat(78))
} else if (pushRequested && pushAcknowledged && !isDev) {
  console.warn(
    '[webdesk-payload] push was requested+acknowledged but NODE_ENV=production — ' +
      'push stays DISABLED regardless. Push is never permitted outside development.',
  )
}

export default buildConfig({
  admin: {
    user: 'users',
  },
  // WSK-06 — additive only: exposes the vocabulary v1 summary (version, primitive/block-type
  // names) so it is inspectable from `getPayload().config.custom.vocabulary` without importing
  // the vocabulary package directly. Does not touch `db`/tenancy config — see the import above.
  custom: {
    vocabulary: VOCABULARY_SUMMARY,
  },
  telemetry: false,
  secret: process.env.PAYLOAD_SECRET || 'wsk-02-dev-secret-replace-me',
  serverURL:
    process.env.PAYLOAD_PUBLIC_SERVER_URL ||
    `http://localhost:${process.env.PAYLOAD_INTERNAL_PORT || 3100}`,
  // WSK-D20: GraphQL is disabled outright at the framework level (defense in depth beyond the
  // public-gateway denylist, and beyond simply never wiring app/(payload)/api/graphql/route.ts —
  // see README.md "GraphQL lockdown" for all three independent layers).
  graphQL: {
    disable: true,
  },
  collections: [
    {
      slug: 'users',
      auth: true,
      admin: { useAsTitle: 'email' },
      fields: [],
    },
    {
      slug: 'pages',
      admin: { useAsTitle: 'title' },
      // WSK-04b (WSK-D25) — app-layer tenant wall, independent of RLS/the GUC. See
      // src/tenant-access.mjs. Inert for Local API callers that don't pass overrideAccess:false
      // (Payload's own default is overrideAccess:true there); load-bearing for REST
      // (app/(payload)/api/[...slug]/route.ts never overrides) and any future admin-panel read.
      access: tenantScopedAccess(),
      fields: [
        {
          name: 'tenantId',
          type: 'text',
          required: true,
          index: true,
          admin: {
            description:
              'Zone B tenants.id — the RLS key. Text, not a DB-level FK: WSK-02 scope is proving ' +
              'boot + the tenancy mechanism end-to-end with one minimal collection, not the full ' +
              'schema (that is WSK-03/04).',
          },
        },
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'textarea' },
      ],
    },
  ],
  db: postgresAdapter({
    pg: tenantAwarePg,
    // Layer-1-style tables could share this database under the shared-instance model (WSK-D16);
    // scoping the filter to Payload's own table names keeps drizzle-kit's dev-push from
    // introspecting unrelated tables and asking interactively whether something is a RENAME —
    // the exact operational hazard FINDINGS.md documents.
    tablesFilter: ['pages', 'users*', 'payload_*'],
    pool: {
      connectionString: process.env.DATABASE_URI,
    },
    push: pushEnabled,
  }),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
