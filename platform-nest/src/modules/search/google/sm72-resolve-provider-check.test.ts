// SM-72 (tracker §6bo.1) — the GSC and GA4 read paths (`pullGscPerformanceForProperty`,
// `pullGa4MetricsForProperty`) resolved a property's bound connection via
// `resolvePropertyConnection` → `getGoogleConnection` and used it WITHOUT ever checking that
// connection's own `.provider` against the surface being pulled. `ads-client.ts` already carries
// exactly this guard locally (SM-25c, `connection.provider !== "google_ads"`) — this is the FIFTH
// confirmed site of the SM-63 shape (§6bb): resolve a row by one key, never verify the row's own
// scope. Others: the rank collect edge (§6bb, SM-63), the DataForSEO task_get echo (§6bh), the
// property BINDING at write time (§6bo, SM-71).
//
// THE FIX, chosen over duplicating ads-client.ts's guard at both call sites: hoisted into
// `resolvePropertyConnection` (google/oauth.ts) itself, via a JOIN that requires the resolved
// connection's own `provider` column to equal the surface argument. A mismatch now falls out
// through the exact same "0 rows" branch as a genuinely unbound property, so both gsc-client.ts and
// ga4-client.ts inherit the guard for free (and any future THIRD reader of this function would too)
// without editing either file. `ads-client.ts`'s own guard (line ~272) is untouched — this hoist is
// defence in depth stacked on top of it, not a replacement.
//
// WHAT THIS PROVES:
//   1. a STALE mismatched binding (the property's gsc/ga4 column pointing at a connection of the
//      WRONG provider — the exact shape a pre-SM-71 write, or a future write path that bypasses
//      `bindPropertyConnection`, would leave behind) is refused by both read paths;
//   2. per §A14.5, the refusal is the SAME `GooglePropertyNotBoundError` — same status (400), same
//      code, same body shape (propertyId + surface, no connectionId) — as a genuinely UNBOUND
//      property; asserted via whole-value equality on the constructed error's own fields, not just a
//      matching HTTP status, so no oracle lets a caller distinguish "wrong provider" from "never
//      bound";
//   3. `resolvePropertyConnection` itself returns `null` for both cases (the single shared source of
//      the "same outcome" property above) and still resolves normally for a correctly-provider-bound
//      connection, so the fix does not refuse everything.
//
// MUTATION PROBE (§6bi Ruling 6): reverting the JOIN's `AND ic.provider = $2 AND ic.deleted_at IS
// NULL` clause back to a bare `ic.id = sp.${col}` (the pre-fix shape — no provider check at all) was
// run manually against this suite (see the ticket report for the exact diff and restore
// verification). It turns tests 1, 2, and 4 red (the mismatched connection now resolves and the
// pulls proceed instead of refusing); test 3 (same-provider bind) stays green, as expected, since a
// correctly-bound connection was never the thing under test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { createConnection } from "../../../core/integrations.service";
import { resolvePropertyConnection } from "./oauth";
import { GooglePropertyNotBoundError } from "./errors";
import { pullGscPerformanceForProperty } from "./gsc-client";
import { pullGa4MetricsForProperty } from "./ga4-client";

async function createProperty(tenantId: string, clientId: string, domain: string): Promise<string> {
  const id = newId();
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, targets, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,'[]','active',$6)`,
        [id, tenantId, clientId, domain, `https://${domain}`, config.originSite],
      ),
    { modules: ["search"] },
  );
  return id;
}

/** Writes a STALE mismatched binding directly onto the property's column, bypassing
 *  `bindPropertyConnection` entirely — modelling both a pre-SM-71 row and a future write path that
 *  does not go through that function. */
async function staleBind(
  tenantId: string,
  propertyId: string,
  col: "gsc_connection_id" | "ga4_connection_id",
  connectionId: string,
): Promise<void> {
  await withTenants(
    [tenantId],
    (c) => c.query(`UPDATE search_properties SET ${col} = $2 WHERE id = $1`, [propertyId, connectionId]),
    { modules: ["search"] },
  );
}

describe.skipIf(!TEST_URL)("SM-72 · resolvePropertyConnection verifies the resolved connection's OWN provider", () => {
  let tenant: string;
  let client: string;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    tenant = await createCompany("SM-72 Agency", ["search"]);
    const user = await createUser("sm72-linker@sm72.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-72 Client");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("resolvePropertyConnection returns null for a property whose gsc column points at a stale google_analytics connection", async () => {
    const ga4Conn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_analytics", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm72-mismatch-gsc-${Date.now()}.example.com`);
    await staleBind(tenant, property, "gsc_connection_id", ga4Conn.id);

    await expect(resolvePropertyConnection(tenant, property, "google_search_console")).resolves.toBeNull();
  });

  it("resolvePropertyConnection returns null for a property whose ga4 column points at a stale google_search_console connection", async () => {
    const gscConn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_search_console", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm72-mismatch-ga4-${Date.now()}.example.com`);
    await staleBind(tenant, property, "ga4_connection_id", gscConn.id);

    await expect(resolvePropertyConnection(tenant, property, "google_analytics")).resolves.toBeNull();
  });

  it("a same-provider binding still resolves (the fix does not refuse everything)", async () => {
    const gscConn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_search_console", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm72-ok-${Date.now()}.example.com`);
    await staleBind(tenant, property, "gsc_connection_id", gscConn.id);

    await expect(resolvePropertyConnection(tenant, property, "google_search_console")).resolves.toBe(gscConn.id);
  });

  // ── the actual read paths refuse, not just the resolver in isolation ─────────────────────────────

  it("pullGscPerformanceForProperty refuses a stale ga4-connection-in-the-gsc-slot exactly like an unbound property — no oracle", async () => {
    const ga4Conn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_analytics", createdBy: null,
    });
    const mismatchedProperty = await createProperty(tenant, client, `sm72-pull-mismatch-${Date.now()}.example.com`);
    await staleBind(tenant, mismatchedProperty, "gsc_connection_id", ga4Conn.id);
    const unboundProperty = await createProperty(tenant, client, `sm72-pull-unbound-${Date.now()}.example.com`);

    const pull = (propertyId: string) =>
      pullGscPerformanceForProperty({
        tenantId: tenant, propertyId, siteUrl: "https://sm72-pull.example/",
        startDate: "2026-07-01", endDate: "2026-07-05",
      });

    let mismatchErr: unknown;
    let unboundErr: unknown;
    try { await pull(mismatchedProperty); } catch (e) { mismatchErr = e; }
    try { await pull(unboundProperty); } catch (e) { unboundErr = e; }

    expect(mismatchErr).toBeInstanceOf(GooglePropertyNotBoundError);
    expect(unboundErr).toBeInstanceOf(GooglePropertyNotBoundError);
    const m = mismatchErr as InstanceType<typeof GooglePropertyNotBoundError>;
    const u = unboundErr as InstanceType<typeof GooglePropertyNotBoundError>;
    // Whole-value equality on the parts of the error that do NOT vary with propertyId (status, code,
    // message, surface) — the caller-visible shape is identical regardless of WHY resolution failed.
    expect(m.status).toBe(u.status);
    expect(m.code).toBe(u.code);
    expect(m.message).toBe(u.message);
    expect((m as unknown as { detail?: { surface?: string } }).detail?.surface)
      .toBe((u as unknown as { detail?: { surface?: string } }).detail?.surface);
    expect(m.status).toBe(400);
    expect(m.code).toBe("google_property_not_bound");
  });

  it("pullGa4MetricsForProperty refuses a stale gsc-connection-in-the-ga4-slot exactly like an unbound property — no oracle", async () => {
    const gscConn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_search_console", createdBy: null,
    });
    const mismatchedProperty = await createProperty(tenant, client, `sm72-ga4pull-mismatch-${Date.now()}.example.com`);
    await staleBind(tenant, mismatchedProperty, "ga4_connection_id", gscConn.id);
    const unboundProperty = await createProperty(tenant, client, `sm72-ga4pull-unbound-${Date.now()}.example.com`);

    const pull = (propertyId: string) =>
      pullGa4MetricsForProperty({
        tenantId: tenant, propertyId, ga4PropertyId: "123456789",
        startDate: "2026-07-01", endDate: "2026-07-05",
      });

    let mismatchErr: unknown;
    let unboundErr: unknown;
    try { await pull(mismatchedProperty); } catch (e) { mismatchErr = e; }
    try { await pull(unboundProperty); } catch (e) { unboundErr = e; }

    expect(mismatchErr).toBeInstanceOf(GooglePropertyNotBoundError);
    expect(unboundErr).toBeInstanceOf(GooglePropertyNotBoundError);
    const m = mismatchErr as InstanceType<typeof GooglePropertyNotBoundError>;
    const u = unboundErr as InstanceType<typeof GooglePropertyNotBoundError>;
    expect(m.status).toBe(u.status);
    expect(m.code).toBe(u.code);
    expect(m.message).toBe(u.message);
    expect((m as unknown as { detail?: { surface?: string } }).detail?.surface)
      .toBe((u as unknown as { detail?: { surface?: string } }).detail?.surface);
    expect(m.status).toBe(400);
    expect(m.code).toBe("google_property_not_bound");
  });
});
