/** Sub-process: seed one row per tenant with a generous pool. */
import { bootPayload } from '../src/lib.mjs';
import { runWithTenant } from '../src/tenant-context.mjs';

const ACME = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';

const payload = await bootPayload({ databaseUri: process.env.DATABASE_URI });
await runWithTenant(ACME, () => payload.create({ collection: 'pages', data: { tenantId: ACME, title: 'ACME leak-probe page' } }));
await runWithTenant(GLOBEX, () => payload.create({ collection: 'pages', data: { tenantId: GLOBEX, title: 'GLOBEX leak-probe page' } }));
console.log('WSK00_RESULT ' + JSON.stringify({ seeded: true }));
process.exit(0);
