// WSK-00 layer 2 - minimal Payload 3 config. ONE real collection ("pages"),
// its table FORCE-RLS'd on webdesk.tenant_ctx by sql/rls-pages.sql (applied
// after the dev schema push - see scripts/setup-schema.mjs). "users" exists
// only because Payload's admin panel requires an auth collection to log in.
import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
// @ts-expect-error - plain .mjs, no types authored for this spike file
import { tenantAwarePg } from './src/tenant-pg.mjs'
// @ts-expect-error - plain .mjs, no types authored for this spike file
import { runWithTenant } from './src/tenant-context.mjs'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: 'users',
  },
  telemetry: false,
  secret: process.env.PAYLOAD_SECRET || 'wsk-00-spike-not-a-real-secret',
  serverURL: process.env.PAYLOAD_PUBLIC_SERVER_URL || 'http://localhost:3111',
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
      fields: [
        {
          name: 'tenantId',
          type: 'text',
          required: true,
          index: true,
          admin: { description: 'Zone B tenants.id - the RLS key. Text, not uuid: kept deliberately dumb for the spike.' },
        },
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'textarea' },
      ],
    },
  ],
  jobs: {
    deleteJobOnComplete: false,
    tasks: [
      {
        slug: 'probeTenantRead',
        // P11: does a queued job that explicitly re-threads its own tenant
        // context (from serialized job.input, the only thing that CAN cross
        // the queue boundary) see only that tenant's rows via ordinary
        // Local API find()?
        inputSchema: [{ name: 'tenantId', type: 'text', required: true }],
        outputSchema: [{ name: 'titles', type: 'json' }],
        handler: async ({ input, req }) => {
          const titles = await runWithTenant(input.tenantId, async () => {
            const res = await req.payload.find({ collection: 'pages', limit: 100, pagination: false })
            return res.docs.map((d: any) => d.title)
          })
          return { output: { titles } }
        },
      },
      {
        slug: 'probeTenantReadNaive',
        // The contrast case: a handler that receives tenantId as input but
        // - by omission, the bug this exists to catch - never re-establishes
        // ALS context before querying. Records whether that FAILS CLOSED
        // (empty result, safe) or LEAKS (another tenant's rows, not safe).
        inputSchema: [{ name: 'tenantId', type: 'text', required: true }],
        outputSchema: [{ name: 'titles', type: 'json' }],
        handler: async ({ req }) => {
          const res = await req.payload.find({ collection: 'pages', limit: 100, pagination: false })
          return { output: { titles: res.docs.map((d: any) => d.title) } }
        },
      },
    ],
  },
  db: postgresAdapter({
    pg: tenantAwarePg,
    // Layer 1's tables (tenants, content_items) live in the SAME database
    // (the shared-instance model WSK-D16 is testing). Without this,
    // drizzle-kit's dev-push introspects the WHOLE public schema, sees
    // "users_sessions" appear for the first time, and asks interactively
    // whether it's actually a RENAME of "tenants" or "content_items" - a
    // real hang, not a hypothetical: see FINDINGS.md "operational hazard".
    // Scoping the filter to Payload's own table names is the fix.
    tablesFilter: ['pages', 'users*', 'payload_*'],
    pool: {
      connectionString: process.env.DATABASE_URI,
      // P13 (the leak probe) sets this to 1 to force physical-connection
      // reuse across tenants, same as layer 1's P4/P4b.
      max: process.env.WSK_POOL_MAX ? Number(process.env.WSK_POOL_MAX) : undefined,
    },
    // dev-only schema push; the migrations probe (P12) exercises the real
    // migrate path separately with push disabled.
    push: process.env.PAYLOAD_ALLOW_PUSH === 'true',
  }),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
})
