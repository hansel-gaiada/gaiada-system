/** Sub-process for P13's write-path check - see _p13_read_subprocess.mjs header. */
import { bootPayload } from '../src/lib.mjs';
import { runWithTenant } from '../src/tenant-context.mjs';

const ACME = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';

const payload = await bootPayload({ databaseUri: process.env.DATABASE_URI });

for (let i = 0; i < 6; i++) {
  const [tid, label] = i % 2 === 0 ? [ACME, 'ACME'] : [GLOBEX, 'GLOBEX'];
  await runWithTenant(tid, () => payload.create({ collection: 'pages', data: { tenantId: tid, title: `${label} tx-leak-probe ${i}` } }));
}

const noTenantFind = await payload.find({ collection: 'pages', where: { title: { like: 'tx-leak-probe' } } });

console.log('WSK00_RESULT ' + JSON.stringify({
  noTenantTitles: noTenantFind.docs.map((d) => d.title),
}));

process.exit(0);
