// DEMO_MODE only. The demo identities that hold an ACTIVE client contact, so the demo portal fixtures
// answer them the way the real portal scope resolver answers a caller with a `client_contacts` row,
// and refuse everyone else with the real 403 ("not a portal client").
//
//   demo-client             a client of co-agency (Northwind Traders), and nothing else.
//   demo-viceroy-marketing  staff of co-resort (Viceroy) AND a client contact of co-agency (PV2-05):
//                           the case where the portal must resolve through `clientOf`, not the employer.
//   demo-two-company-client a client of co-agency AND co-resort (PV2-05), the only identity that sees the
//                           company switch. The demo fixtures answer it the same for both companies;
//                           per-company isolation is proven against a real database, not here.
//
// Keep in step with `DEMO_CLIENT_OF` in demoFixtures.ts (the `/api/me` `clientOf` per identity). One
// list, read by every demo portal fixture, so a second client identity cannot be honoured by one
// fixture and refused by another.
export const DEMO_PORTAL_CLIENT_USERS: ReadonlySet<string> = new Set([
  "demo-client", "demo-viceroy-marketing", "demo-two-company-client",
]);

export function isDemoPortalClient(userId: string): boolean {
  return DEMO_PORTAL_CLIENT_USERS.has(userId);
}
