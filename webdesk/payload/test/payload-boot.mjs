/**
 * Local-API boot helper for tests, run with `node --import tsx` (payload.config.ts is TS).
 * Push is always false here — tests boot against a schema already pushed+RLS'd by
 * scripts/setup-schema.mjs.
 */
export async function bootPayload({ databaseUri }) {
  process.env.DATABASE_URI = databaseUri
  process.env.PAYLOAD_ALLOW_PUSH = 'false'
  process.env.PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS = 'false'
  process.env.NODE_ENV = process.env.NODE_ENV || 'development'

  const { getPayload } = await import('payload')
  // Cache-bust like the spike's src/lib.mjs: payload.config.ts's postgresAdapter(...) call reads
  // env vars at MODULE EVALUATION time, and ESM caches by exact specifier string.
  const config = (await import(`../payload.config.ts?boot=${Date.now()}-${Math.random()}`)).default
  return getPayload({ config })
}
