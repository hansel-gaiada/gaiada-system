// SM-71 (tracker §6bm.1) — `bindPropertyConnection` did not verify a connection's OWN `.provider`
// before binding it to a property's surface column, so a Search Console connection could be bound into
// the Ads slot (or vice versa). This is the THIRD site of the SM-63 shape (§6bb): resolve a row by one
// key, then never verify the row's own scope. Found by the SM-25c agent (defending its own pull with
// `connection.provider !== "google_ads"`) in a file it did not own, and correctly reported rather than
// fixed. Fixed here, in google/oauth.ts (the connection-resolution home), so search.controller.ts's
// `bindGooglePropertyConnection` route — owned by SM-21, not edited by this ticket — inherits the check
// for free.
//
// WHAT THIS PROVES:
//   1. binding a GA4 connection into the Search Console slot (and vice versa) is refused;
//   2. per addendum §A14.5, the refusal is IDENTICAL — whole-body equality, not just a matching status
//      code — to the refusal for a connectionId that does not exist at all: no oracle lets a caller
//      distinguish "wrong provider" from "no such connection";
//   3. a same-provider bind still succeeds (so the fix does not just refuse everything);
//   4. a mutation probe (the plausible defect shape — dropping the provider comparison back to a bare
//      existence check, i.e. exactly the pre-fix code) was run manually against this suite outside of
//      CI (see the ticket report): it turns tests 1-2 red, and the restore was hash-verified. It is not
//      encoded as an in-suite self-mutating test — rewriting this module's own source mid-run under
//      vitest's ESM transform is not a reliable way to reload the mutated code, and a probe that cannot
//      be trusted to run the mutated path is worse than no probe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { createConnection } from "../../../core/integrations.service";
import { bindPropertyConnection } from "./oauth";

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

describe.skipIf(!TEST_URL)("SM-71 · bindPropertyConnection verifies the connection's OWN provider", () => {
  let tenant: string;
  let client: string;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    tenant = await createCompany("SM-71 Agency", ["search"]);
    const user = await createUser("sm71-linker@sm71.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-71 Client");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("refuses to bind a google_analytics connection into the google_search_console slot", async () => {
    const ga4Conn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_analytics", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm71-mismatch-${Date.now()}.example.com`);

    const bound = await bindPropertyConnection(tenant, property, "google_search_console", ga4Conn.id);
    expect(bound).toBe(false);
  });

  it("refuses to bind a google_search_console connection into the google_ads slot", async () => {
    const gscConn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_search_console", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm71-mismatch2-${Date.now()}.example.com`);

    const bound = await bindPropertyConnection(tenant, property, "google_ads", gscConn.id);
    expect(bound).toBe(false);
  });

  it("a same-provider bind still succeeds (the fix does not refuse everything)", async () => {
    const gscConn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_search_console", createdBy: null,
    });
    const property = await createProperty(tenant, client, `sm71-ok-${Date.now()}.example.com`);

    const bound = await bindPropertyConnection(tenant, property, "google_search_console", gscConn.id);
    expect(bound).toBe(true);
  });

  // ── no-oracle: whole-body equality between "wrong provider" and "genuinely not found" ────────────
  it("the wrong-provider refusal and the connection-does-not-exist refusal are the SAME outcome — no oracle", async () => {
    const ga4Conn = await createConnection(tenant, {
      ownerKind: "client", ownerId: client, provider: "google_analytics", createdBy: null,
    });
    const propertyA = await createProperty(tenant, client, `sm71-oracle-a-${Date.now()}.example.com`);
    const propertyB = await createProperty(tenant, client, `sm71-oracle-b-${Date.now()}.example.com`);

    const wrongProviderResult = await bindPropertyConnection(tenant, propertyA, "google_search_console", ga4Conn.id);
    const notFoundResult = await bindPropertyConnection(tenant, propertyB, "google_search_console", newId());

    // Both are `false`; the function's return type is a plain boolean, so "whole-body equality" here
    // means the two outcomes are literally the same value — there is no richer shape to diverge.
    expect(wrongProviderResult).toBe(notFoundResult);
    expect(wrongProviderResult).toBe(false);
  });

});
