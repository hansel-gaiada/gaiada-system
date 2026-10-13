// M6-P6i — the claim (and the production row) create or link the domain's `search_properties` row, and the consent gate holds.
// Live-Postgres suite (same posture as site-registry.service.test.ts): the failure classes here are RLS ones (the search wall
// returns ZERO rows without an error when the scope is not declared) and a consent gate that opens by accident, and both only
// manifest through real RLS and the REAL probe-target SQL (client-targets.ts PROBEABLE_SQL, the monitoring runner's own gate).
//
// What it proves:
//   - a CLIENT site's claim creates the property UNVERIFIED, under the client, and MON-01's SQL does not list it; once the
//     probe-consent approval's effect lands (verified_at set), it is listed;
//   - an INTERNAL site (no client, or the sentinel as its client) is verified, under the sentinel, ONLY once the D36 sentinel
//     exists: with none, nothing is created and the claim stands; with two, nothing is created;
//   - an existing property for the domain (any case) is LINKED and left exactly as it was; one owned by another client refuses the
//     claim (409 property_domain_conflict) and the claim rolls back with it (the row is still on its placeholder);
//   - the production row from a staging row gets the same treatment, with its own refusal;
//   - the registry change and its property commit together, and the event says what was linked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import { withTenants } from "../../db";
import { PROBEABLE_SQL } from "../monitoring/client-targets";
import { DeliveryRefusal } from "./delivery-binding";
import { claimProvisionedSiteDomain, createProductionFromStaging, createWebdevSite, getWebdevSite } from "./site-registry.service";

describe.skipIf(!TEST_URL)("claim -> search_properties link and the consent gate (M6-P6i)", () => {
  let none: string; // a company with NO internal sentinel
  let sen: string; // a company with exactly one
  let two: string; // a company with two (ambiguous)
  let noneClient: string;
  let senClient: string;
  let senSentinel: string;

  beforeAll(async () => {
    await initTestDb();
    none = await createCompany("Link Co No Sentinel", ["webdev", "search"]);
    sen = await createCompany("Link Co Sentinel", ["webdev", "search"]);
    two = await createCompany("Link Co Two Sentinels", ["webdev", "search"]);
    noneClient = await createClient(none, "Real Client N");
    senClient = await createClient(sen, "Real Client S");
    senSentinel = await createClient(sen, "Internal S");
    await adminPool().query(`UPDATE clients SET is_internal = true WHERE id = $1`, [senSentinel]);
    for (const n of ["Internal T1", "Internal T2"]) {
      const id = await createClient(two, n);
      await adminPool().query(`UPDATE clients SET is_internal = true WHERE id = $1`, [id]);
    }
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  const placeholder = (slug: string) => `${slug}.provisioned.invalid`;
  const provisioned = (t: string, slug: string, clientId: string | null = null) =>
    createWebdevSite(t, { domain: placeholder(slug), origin: "provisioned", adoption: "mandated", environment: "staging", clientId }, null);

  /** Every property row for the domain, read under the SEARCH scope (the wall: a webdev-only read would return zero rows). */
  const propertiesOf = (t: string, domain: string) =>
    withTenants(
      [t],
      (c) =>
        c.query<{ id: string; client_id: string; verified_at: Date | null; site_url: string; status: string }>(
          `SELECT id, client_id, verified_at, site_url, status FROM search_properties WHERE tenant_id = $1 AND lower(domain) = lower($2) AND deleted_at IS NULL`,
          [t, domain],
        ),
      { modules: ["search"] },
    ).then((r) => r.rows);

  /** What MON-01 would probe for this tenant: the real consent-gate SQL. */
  const probeable = (t: string) =>
    withTenants([t], (c) => c.query<{ domain: string; client_id: string; is_internal: boolean }>(PROBEABLE_SQL), { modules: ["search"] }).then((r) => r.rows);

  const linkedEvents = (t: string, siteId: string) =>
    withTenants([t], (c) =>
      c.query<{ payload: { domain: string; state: string; propertyId: string | null; verified: boolean; internal: boolean; reason: string | null } }>(
        `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.property_linked'`,
        [siteId],
      ),
    ).then((r) => r.rows.map((x) => x.payload));

  // ── a client's site ───────────────────────────────────────────────────────────────────────────────────────────

  it("a CLIENT site's claim creates the property UNVERIFIED under the client, and MON-01's SQL does not list it", async () => {
    const site = await provisioned(none, "client-claim", noneClient);
    const claimed = await claimProvisionedSiteDomain(none, site.id, "client-claim.example.com", null);
    expect(claimed.domain).toBe("client-claim.example.com");
    expect(claimed.property).toMatchObject({ state: "created", verified: false, internal: false, reason: null });
    const rows = await propertiesOf(none, "client-claim.example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: claimed.property.propertyId, client_id: noneClient, verified_at: null, site_url: "https://client-claim.example.com/", status: "active" });
    expect((await probeable(none)).map((r) => r.domain)).not.toContain("client-claim.example.com");
    // ...and the event names what was linked, never a credential.
    const events = await linkedEvents(none, site.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ domain: "client-claim.example.com", state: "created", propertyId: claimed.property.propertyId, verified: false, internal: false, reason: null });
  });

  it("the consent gate OPENS only when the probe-consent effect sets verified_at (the claim never does): then, and only then, MON-01 lists the domain", async () => {
    const site = await provisioned(none, "client-consent", noneClient);
    const claimed = await claimProvisionedSiteDomain(none, site.id, "client-consent.example.com", null);
    expect((await probeable(none)).map((r) => r.domain)).not.toContain("client-consent.example.com");
    // What modules/search/probe-consent.ts does on an approved request, as the superuser pool:
    await adminPool().query(`UPDATE search_properties SET verified_at = now() WHERE id = $1`, [claimed.property.propertyId]);
    const listed = (await probeable(none)).find((r) => r.domain === "client-consent.example.com");
    expect(listed).toMatchObject({ client_id: noneClient, is_internal: false });
  });

  it("a client's domain is never filed under the sentinel, even in a company that has one", async () => {
    const site = await provisioned(sen, "client-with-sentinel", senClient);
    const claimed = await claimProvisionedSiteDomain(sen, site.id, "client-with-sentinel.example.com", null);
    expect(claimed.property).toMatchObject({ state: "created", verified: false, internal: false });
    expect((await propertiesOf(sen, "client-with-sentinel.example.com"))[0]).toMatchObject({ client_id: senClient, verified_at: null });
  });

  // ── an internal site ──────────────────────────────────────────────────────────────────────────────────────────

  it("an INTERNAL site (no client) WITHOUT the D36 sentinel: nothing is created, the claim stands, MON-01 probes nothing", async () => {
    const site = await provisioned(none, "internal-nosentinel");
    const claimed = await claimProvisionedSiteDomain(none, site.id, "internal-nosentinel.example.com", null);
    expect(claimed.domain).toBe("internal-nosentinel.example.com");
    expect(claimed.property).toEqual({ state: "skipped", propertyId: null, verified: false, internal: true, reason: "no_internal_sentinel" });
    expect(await propertiesOf(none, "internal-nosentinel.example.com")).toHaveLength(0);
    expect((await probeable(none)).map((r) => r.domain)).not.toContain("internal-nosentinel.example.com");
    expect((await getWebdevSite(none, site.id))?.domain).toBe("internal-nosentinel.example.com");
    expect((await linkedEvents(none, site.id))[0]).toMatchObject({ state: "skipped", reason: "no_internal_sentinel" });
  });

  it("an INTERNAL site WITH the sentinel: the property is created VERIFIED under the sentinel, and MON-01 lists it as internal", async () => {
    const site = await provisioned(sen, "internal-sentinel");
    const claimed = await claimProvisionedSiteDomain(sen, site.id, "internal-sentinel.example.com", null);
    expect(claimed.property).toMatchObject({ state: "created", verified: true, internal: true });
    const rows = await propertiesOf(sen, "internal-sentinel.example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: senSentinel });
    expect(rows[0].verified_at).not.toBeNull();
    expect((await probeable(sen)).find((r) => r.domain === "internal-sentinel.example.com")).toMatchObject({ client_id: senSentinel, is_internal: true });
  });

  it("a site whose client IS the sentinel (after the P3b backfill) is internal too: verified, under that client", async () => {
    const site = await provisioned(sen, "client-is-sentinel", senSentinel);
    const claimed = await claimProvisionedSiteDomain(sen, site.id, "client-is-sentinel.example.com", null);
    expect(claimed.property).toMatchObject({ state: "created", verified: true, internal: true });
    expect((await propertiesOf(sen, "client-is-sentinel.example.com"))[0]).toMatchObject({ client_id: senSentinel });
  });

  it("with MORE THAN ONE sentinel: nothing is created (the M5-G0 script's own refusal), the claim stands", async () => {
    const site = await provisioned(two, "internal-ambiguous");
    const claimed = await claimProvisionedSiteDomain(two, site.id, "internal-ambiguous.example.com", null);
    expect(claimed.property).toMatchObject({ state: "skipped", propertyId: null, reason: "ambiguous_internal_sentinel" });
    expect(await propertiesOf(two, "internal-ambiguous.example.com")).toHaveLength(0);
  });

  // ── an existing property ──────────────────────────────────────────────────────────────────────────────────────

  it("an EXISTING property of the same client is LINKED and left exactly as it was (its verified_at is neither granted nor taken), whatever the case of the stored domain", async () => {
    const t = none;
    const verifiedAt = "2026-09-01T10:00:00Z";
    const ins = (domain: string, verified: string | null) =>
      adminPool().query<{ id: string }>(
        `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, verified_at, origin_site) VALUES ($1, $2, $3, $4, $5, 'link-test') RETURNING id`,
        [t, noneClient, domain, `https://${domain.toLowerCase()}/`, verified],
      ).then((r) => r.rows[0].id);
    const unverifiedId = await ins("Linked-Unverified.example.com", null); // stored in MIXED case: search_properties has no lowercase CHECK
    const verifiedId = await ins("linked-verified.example.com", verifiedAt);

    const a = await claimProvisionedSiteDomain(t, (await provisioned(t, "link-a", noneClient)).id, "linked-unverified.example.com", null);
    expect(a.property).toEqual({ state: "linked", propertyId: unverifiedId, verified: false, internal: false, reason: null });
    expect((await propertiesOf(t, "linked-unverified.example.com"))).toHaveLength(1); // no second row
    expect((await propertiesOf(t, "linked-unverified.example.com"))[0].verified_at).toBeNull();

    const b = await claimProvisionedSiteDomain(t, (await provisioned(t, "link-b", noneClient)).id, "linked-verified.example.com", null);
    expect(b.property).toEqual({ state: "linked", propertyId: verifiedId, verified: true, internal: false, reason: null });
    expect((await propertiesOf(t, "linked-verified.example.com"))[0].verified_at?.toISOString()).toBe(new Date(verifiedAt).toISOString());
  });

  it("an existing property owned by ANOTHER client refuses the claim (409 property_domain_conflict), and the claim ROLLS BACK with it", async () => {
    const t = none;
    const otherClient = await createClient(t, "Other Real Client");
    await adminPool().query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, origin_site) VALUES ($1, $2, 'owned-by-other.example.com', 'https://owned-by-other.example.com/', 'link-test')`,
      [t, otherClient],
    );
    const site = await provisioned(t, "conflict", noneClient);
    await expect(claimProvisionedSiteDomain(t, site.id, "owned-by-other.example.com", null)).rejects.toMatchObject({ status: 409, message: "property_domain_conflict" });
    // The registry row is still on its placeholder: the refusal rolled the claim back, so it can be claimed with a different domain.
    expect((await getWebdevSite(t, site.id))?.domain).toBe(placeholder("conflict"));
    expect((await propertiesOf(t, "owned-by-other.example.com")).map((r) => r.client_id)).toEqual([otherClient]);
    const retry = await claimProvisionedSiteDomain(t, site.id, "owned-by-nobody.example.com", null);
    expect(retry.property.state).toBe("created");
  });

  it("an internal site cannot take over a domain a REAL client's property already holds", async () => {
    const t = sen;
    await adminPool().query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, origin_site) VALUES ($1, $2, 'real-client-holds.example.com', 'https://real-client-holds.example.com/', 'link-test')`,
      [t, senClient],
    );
    const site = await provisioned(t, "internal-conflict");
    await expect(claimProvisionedSiteDomain(t, site.id, "real-client-holds.example.com", null)).rejects.toMatchObject({ status: 409, message: "property_domain_conflict" });
    expect((await getWebdevSite(t, site.id))?.domain).toBe(placeholder("internal-conflict"));
  });

  // ── the production row ────────────────────────────────────────────────────────────────────────────────────────

  it("the PRODUCTION row made from a staging row gets the same treatment: a client's property, unverified; and a conflicting owner refuses it with its own typed reason", async () => {
    const t = none;
    const staging = await provisioned(t, "prod-link", noneClient);
    const prod = await createProductionFromStaging(t, staging.id, "prod-link.example.com", null);
    expect(prod.environment).toBe("production");
    expect(prod.property).toMatchObject({ state: "created", verified: false, internal: false });
    expect((await propertiesOf(t, "prod-link.example.com"))[0]).toMatchObject({ client_id: noneClient, verified_at: null });
    expect((await probeable(t)).map((r) => r.domain)).not.toContain("prod-link.example.com");

    const otherClient = await createClient(t, "Other Prod Client");
    await adminPool().query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, origin_site) VALUES ($1, $2, 'prod-conflict.example.com', 'https://prod-conflict.example.com/', 'link-test')`,
      [t, otherClient],
    );
    const staging2 = await provisioned(t, "prod-conflict", noneClient);
    const refused = createProductionFromStaging(t, staging2.id, "prod-conflict.example.com", null);
    await expect(refused).rejects.toBeInstanceOf(DeliveryRefusal);
    await expect(refused).rejects.toMatchObject({ code: "property_domain_conflict", status: 409 });
    // Nothing was created: no production row for the staging row (a retry with another domain works).
    const retry = await createProductionFromStaging(t, staging2.id, "prod-conflict-ok.example.com", null);
    expect(retry.environment).toBe("production");
  });

  it("the search wall is real: a webdev-only read of search_properties returns ZERO rows (which is why the claim declares BOTH scopes)", async () => {
    const t = none;
    expect((await propertiesOf(t, "client-claim.example.com")).length).toBeGreaterThan(0);
    const webdevOnly = await withTenants([t], (c) => c.query(`SELECT 1 FROM search_properties WHERE tenant_id = $1`, [t]), { modules: ["webdev"] });
    expect(webdevOnly.rows).toHaveLength(0);
  });
});
