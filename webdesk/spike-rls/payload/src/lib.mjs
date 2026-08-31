/**
 * Shared plumbing for the payload/ probes: boot a Local API `payload`
 * instance against the app role (webdesk_app, NOBYPASSRLS - the role that
 * actually proves anything about RLS), and the two fixed tenant ids the raw
 * layer-1 probes already seeded into tenants/content_items (reused here so
 * FINDINGS.md can be read against the same fixtures).
 */
export const ACME = '11111111-1111-1111-1111-111111111111';
export const GLOBEX = '22222222-2222-2222-2222-222222222222';

export const APP_URI = 'postgres://webdesk_app:spike_app_pw@localhost:55432/webdesk_spike';
export const MIGRATOR_URI = 'postgres://webdesk_migrator:spike_migrator_pw@localhost:55432/webdesk_spike';
export const OWNER_URI = 'postgres://webdesk_owner:spike_owner_pw@localhost:55432/webdesk_spike';

let cachedPayload;

export async function bootPayload({ databaseUri = APP_URI, poolMax } = {}) {
  process.env.DATABASE_URI = databaseUri;
  process.env.PAYLOAD_ALLOW_PUSH = 'false'; // schema already exists; app role can't push anyway
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  if (poolMax) process.env.WSK_POOL_MAX = String(poolMax);

  const { getPayload } = await import('payload');
  // Cache-bust: payload.config.ts reads DATABASE_URI/WSK_POOL_MAX at MODULE
  // EVALUATION time (inside the postgresAdapter(...) call), and ESM caches a
  // module by its exact specifier string. A probe that needs two different
  // pool configs in one process (P13) would silently get the FIRST config
  // again without this - not a Payload quirk, just how ESM caching works.
  const config = (await import(`../payload.config.ts?boot=${Date.now()}-${Math.random()}`)).default;
  cachedPayload = await getPayload({ config });
  return cachedPayload;
}

export async function seedRow({ payload, tenantId, title, body = '' }) {
  const { runWithTenant } = await import('./tenant-context.mjs');
  return runWithTenant(tenantId, () =>
    payload.create({ collection: 'pages', data: { tenantId, title, body } }),
  );
}

export const results = [];
let pass = 0;
let fail = 0;

export function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} -- ${detail ?? ''}`);
  }
}

export function summary(label) {
  console.log(`\n  ${label}: ${pass} passed, ${fail} failed`);
  return fail === 0;
}
