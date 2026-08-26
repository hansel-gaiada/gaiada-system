/**
 * Sub-process for P13's read-path check. Isolated into its own process (own
 * getPayload() lifecycle, own pool) - see FINDINGS.md for why.
 *
 * Pool max=1 turned out to deadlock Payload's find() itself (reproduced
 * with vanilla `pg`, unrelated to this spike's wrapper - see FINDINGS.md
 * "operational hazard #2"), so this uses max=2 and proves reuse
 * DETERMINISTICALLY instead of by brute force: 3 sequential checkouts
 * against a pool of 2 physical connections guarantees (pigeonhole) at least
 * one repeat - tenant-pg.mjs tags every physical client with a stable id so
 * the repeat can be confirmed directly from the checkout log, not inferred.
 */
import { bootPayload } from '../src/lib.mjs';
import { runWithTenant } from '../src/tenant-context.mjs';
import { tenantCheckoutLog } from '../src/tenant-pg.mjs';

const ACME = '11111111-1111-1111-1111-111111111111';
const GLOBEX = '22222222-2222-2222-2222-222222222222';

const payload = await bootPayload({ databaseUri: process.env.DATABASE_URI });

const beforeLen = tenantCheckoutLog.length;
const acmeRes = await runWithTenant(ACME, () => payload.find({ collection: 'pages', pagination: false }));
const noTenantRes = await payload.find({ collection: 'pages', pagination: false }); // no context at all
const globexRes = await runWithTenant(GLOBEX, () => payload.find({ collection: 'pages', pagination: false }));

const events = tenantCheckoutLog.slice(beforeLen).filter((e) => e.phase === 'checkout');
const connIds = events.map((e) => e.connId);
const distinctConnIds = new Set(connIds);
// pigeonhole: 3 checkouts against >=1 physical connections and pool max=2
// guarantees at least one id repeats if the pool actually reused a
// connection rather than opening a fresh one for every request.
const reuseObserved = distinctConnIds.size < events.length;

console.log('WSK00_RESULT ' + JSON.stringify({
  acmeTitles: acmeRes.docs.map((d) => d.title),
  noTenantTitles: noTenantRes.docs.map((d) => d.title),
  globexTitles: globexRes.docs.map((d) => d.title),
  checkoutConnIds: connIds,
  reuseObserved,
}));

process.exit(0);
