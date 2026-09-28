// Client Centre — STAFF route real-DB proofs (CC piece 2/F). See
// docs/plans/2026-09-29-client-centre.md. Modeled on portal-dashboard.test.ts's own app.inject()
// harness. Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { buildApp } from "../../../main";
import { resetModules } from "../../registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { withTenants } from "../../../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("Client Centre · staff routes (clients-centre.controller.ts)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coNoModule: string;
  let admin: string;      // company_admin — read + update
  let viewer: string;     // viewer — read only, no update
  let outsider: string;   // member of a DIFFERENT tenant entirely
  let clientA: string;
  let clientB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    co = await createCompany("Centre Staff Co", ["clients"]);
    coNoModule = await createCompany("Centre No Module Co", []);

    admin = await createUser("centre-admin@a.test");
    viewer = await createUser("centre-viewer@a.test");
    outsider = await createUser("centre-outsider@b.test");
    await addMembership(co, admin);
    await addMembership(co, viewer);
    await addMembership(coNoModule, outsider);

    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    await grantRole(outsider, await createRole("company_admin"), "company", coNoModule);

    clientA = await createClient(co, "Alpha Co");
    clientB = await createClient(co, "Beta Co");

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── module gate ────────────────────────────────────────────────────────────────────────────────
  it("404s when the tenant has not enabled the clients module", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${coNoModule}/clients/centre`, headers: asUser(outsider) });
    expect(r.statusCode).toBe(404);
  });

  // ── the static-route-vs-:clientId collision (explicitly verified, per the ticket's own instruction) ─
  it("GET /clients/centre resolves the STATIC list route, never :clientId=\"centre\"", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/centre`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true); // the list shape, not a 404/"client not found" from
    // the :clientId route treating "centre" as an id and failing to find a client named "centre".
  });

  it("list contains every non-deleted client with defaults for one with no profile row yet", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/centre`, headers: asUser(admin) });
    const rows = r.json() as Array<{
      clientId: string; businessType: string;
      fieldsFilled: { filled: number; total: number }; connectionsConnected: { connected: number; total: number };
    }>;
    const a = rows.find((x) => x.clientId === clientA);
    // `total`s are registry-derived, not zero: 23 Company-settings fields, 98 distinct connection
    // ids reachable across all 28 sections for the "other" business type (no industry module).
    expect(a).toMatchObject({
      businessType: "other",
      fieldsFilled: { filled: 0, total: 23 },
      connectionsConnected: { connected: 0, total: 98 },
    });
  });

  // ── read/update authz ──────────────────────────────────────────────────────────────────────────
  it("company_admin can read and gets canEdit:true", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ clientId: clientA, clientName: "Alpha Co", businessType: "other", revision: 0, canEdit: true });
  });

  it("viewer can read but gets canEdit:false", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(viewer) });
    expect(r.statusCode).toBe(200);
    expect(r.json().canEdit).toBe(false);
  });

  it("viewer is DENIED the PATCH (403)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(viewer),
      payload: { profile: { legal: "Alpha Pte Ltd" } },
    });
    expect(r.statusCode).toBe(403);
  });

  it("an outsider (different tenant) cannot read this tenant's client centre", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(outsider) });
    expect(r.statusCode).toBe(403);
  });

  it("404s a client that does not exist", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${co}/clients/00000000-0000-0000-0000-000000000000/centre`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(404);
  });

  // ── the accepted write: revision, activity, event, canEdit ────────────────────────────────────
  it("company_admin PATCH updates the profile, increments revision, and returns the merged shape", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin),
      payload: { businessType: "hotel", profile: { legal: "Alpha Pte Ltd", city: "Bali" }, departments: { rs: false } },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.businessType).toBe("hotel");
    expect(b.profile).toMatchObject({ legal: "Alpha Pte Ltd", city: "Bali" });
    expect(b.departments).toMatchObject({ rs: false });
    expect(b.revision).toBe(1);
    expect(b.updatedBy).toMatchObject({ id: admin });
  });

  it("revision increments again on a second real change, and stays put on a no-op", async () => {
    const r1 = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin),
      payload: { profile: { tagline: "Island getaway" } },
    });
    expect(r1.json().revision).toBe(2);

    const r2 = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin),
      payload: { profile: { tagline: "Island getaway" } }, // identical value
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().revision).toBe(2); // unchanged — no-op write
  });

  it("writes exactly ONE activity row per accepted write, with the documented shape", async () => {
    const before = await withTenants([co], (c) =>
      c.query(`SELECT count(*) AS n FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1`, [clientA]),
    );
    await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin),
      payload: { profile: { website: "https://alpha.example" } },
    });
    const after = await withTenants([co], (c) =>
      c.query<{ verb: string; metadata: { via: string; changes: Array<{ path: string; before: unknown; after: unknown }> } }>(
        `SELECT verb, metadata FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [clientA],
      ),
    );
    const beforeN = Number(before.rows[0].n);
    const afterCount = await withTenants([co], (c) =>
      c.query(`SELECT count(*) AS n FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1`, [clientA]),
    );
    expect(Number(afterCount.rows[0].n)).toBe(beforeN + 1);
    expect(after.rows[0].verb).toBe("updated");
    expect(after.rows[0].metadata.via).toBe("client-centre");
    expect(after.rows[0].metadata.changes).toEqual([
      { path: "profile.website", before: null, after: "https://alpha.example" },
    ]);
  });

  it("a no-op PATCH writes NO activity row", async () => {
    const before = await withTenants([co], (c) =>
      c.query(`SELECT count(*) AS n FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1`, [clientA]),
    );
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientA}/centre`, headers: asUser(admin),
      payload: { profile: { website: "https://alpha.example" } }, // same value again
    });
    expect(r.statusCode).toBe(200);
    const after = await withTenants([co], (c) =>
      c.query(`SELECT count(*) AS n FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1`, [clientA]),
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  // ── validation surfaces through the route ──────────────────────────────────────────────────────
  it("refuses a credential-looking value with 400, naming the field", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientB}/centre`, headers: asUser(admin),
      payload: { connections: { ga4: { creds: "AKIAABCDEFGHIJKLMNOP" } } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/credential/i);
  });

  it("refuses an unknown profile field with 400, naming it", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientB}/centre`, headers: asUser(admin),
      payload: { profile: { not_a_real_field: "x" } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain("not_a_real_field");
  });

  it("delete semantics: null removes a profile key and connections.null removes the whole entry", async () => {
    await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientB}/centre`, headers: asUser(admin),
      payload: { profile: { legal: "Beta Co Ltd" }, connections: { ga4: { tool: "GA4" } } },
    });
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/clients/${clientB}/centre`, headers: asUser(admin),
      payload: { profile: { legal: null }, connections: { ga4: null } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().profile.legal).toBeUndefined();
    expect(r.json().connections.ga4).toBeUndefined();
  });

  // ── tenant isolation ───────────────────────────────────────────────────────────────────────────
  it("clientB's profile is invisible from a different tenant's client id (RLS + FK tenant guard)", async () => {
    // clientB belongs to `co`; asking under a DIFFERENT (but real) tenant id must 403/404, never leak.
    const r = await app.inject({
      method: "GET", url: `/api/${coNoModule}/clients/${clientB}/centre`, headers: asUser(outsider),
    });
    expect([403, 404]).toContain(r.statusCode);
  });
});
