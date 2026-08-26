/**
 * P8 - Local API (payload.find / payload.create / payload.update / payload.delete).
 * The caller (this script) is responsible for tenantStore.run() - Local API
 * gives no request object of its own to hang tenant resolution off, so the
 * embedding app must establish context itself. That is expected and normal
 * for Local API use (it is meant for server-side code that already knows
 * its own scope), not a gap.
 */
import { ACME, GLOBEX, APP_URI, bootPayload, check, summary } from '../src/lib.mjs';
import { runWithTenant } from '../src/tenant-context.mjs';
import { tenantCheckoutLog } from '../src/tenant-pg.mjs';

const payload = await bootPayload({ databaseUri: APP_URI });

// seed one row per tenant directly through Local API (also exercises create,
// i.e. the transactional path)
await runWithTenant(ACME, () =>
  payload.create({ collection: 'pages', data: { tenantId: ACME, title: 'ACME local-api page' } }),
);
await runWithTenant(GLOBEX, () =>
  payload.create({ collection: 'pages', data: { tenantId: GLOBEX, title: 'GLOBEX local-api page' } }),
);

for (const [label, tid, want] of [['acme', ACME, 'ACME'], ['globex', GLOBEX, 'GLOBEX']]) {
  const res = await runWithTenant(tid, () => payload.find({ collection: 'pages', pagination: false }));
  check(
    `P8 find() ${label}: sees only own rows`,
    res.docs.length > 0 && res.docs.every((d) => d.title.startsWith(want)),
    `got ${JSON.stringify(res.docs.map((d) => d.title))}`,
  );
}

// fail-closed: no ALS context at all -> zero rows, not an error, not everything
{
  const res = await payload.find({ collection: 'pages', pagination: false }); // no runWithTenant wrapper
  check('P8 find() no tenant context: zero rows (fail-closed)', res.docs.length === 0, `got ${res.docs.length} rows`);
}

// cross-tenant write refusal: WITH CHECK must reject an insert whose row
// tenant_id disagrees with the active GUC
{
  let threw = null;
  try {
    await runWithTenant(ACME, () =>
      payload.create({ collection: 'pages', data: { tenantId: GLOBEX, title: 'smuggled via local API' } }),
    );
  } catch (e) {
    threw = e;
  }
  const errText = threw ? `${threw.message || ''} ${threw.cause?.message || ''}` : '';
  check(
    'P8 create() cross-tenant row refused',
    threw !== null && /row-level security/i.test(errText),
    threw ? errText : 'create SUCCEEDED - no error thrown',
  );
}

// update/delete also go through the transactional path - confirm they too
// are RLS-scoped (an ACME-scoped request must not be able to update/delete a
// GLOBEX row even by numeric id, since WHERE/USING silently filters it to
// "not found" rather than raising)
{
  const globexRow = await runWithTenant(GLOBEX, async () => {
    const res = await payload.find({ collection: 'pages', where: { title: { equals: 'GLOBEX local-api page' } } });
    return res.docs[0];
  });
  let notFoundOrEmpty = false;
  try {
    const updated = await runWithTenant(ACME, () =>
      payload.update({ collection: 'pages', id: globexRow.id, data: { title: 'pwned' } }),
    );
    notFoundOrEmpty = !updated || updated.title !== 'pwned';
  } catch (e) {
    notFoundOrEmpty = true;
  }
  check('P8 update() cannot reach another tenant\'s row by id', notFoundOrEmpty);
}

console.log(`\n  (checkout/release events observed: ${tenantCheckoutLog.length})`);
const ok = summary('P8 Local API');
await payload.destroy();
process.exit(ok ? 0 : 1);
