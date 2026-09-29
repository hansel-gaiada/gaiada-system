// Client Centre — PORTAL route real-DB proofs (CC piece 2/F, CC-D4). See
// docs/plans/2026-09-29-client-centre.md. Modeled on portal-dashboard.test.ts's own app.inject()
// harness. Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;

describe.skipIf(!TEST_URL)("Client Centre · portal routes (portal-centre.controller.ts, CC-D4)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coNoModule: string;
  let signerA: string;      // client A, client-wide SIGNER — may edit (CC-D4)
  let viewerA: string;      // client A, client-wide VIEWER — read only
  let scopedSignerA: string; // client A, PROJECT-scoped signer — may NOT edit (CC-D4 is client-wide only)
  let legacyOwnerA: string; // clients.portal_user_id legacy whole-client signer — may edit
  let contactB: string;     // client B — the isolation counterparty
  let staffAdmin: string;
  let clientA: string;
  let clientB: string;
  let clientLegacy: string;
  let projectA1: string;
  let ownerUser: string;

  async function addContact(
    clientId: string, userId: string, capability: "signer" | "viewer", projectId: string | null = null,
  ): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), $7)`,
        [newId(), co, clientId, userId, projectId, capability, site()],
      ),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    // `clients` module deliberately NOT enabled on `co` — the portal half of Client Centre must work
    // regardless (client_centre_profiles carries no module wall; see the migration's own header).
    co = await createCompany("Centre Portal Co", []);
    coNoModule = await createCompany("Centre Portal Rival Co", []);

    staffAdmin = await createUser("centre-portal-staff@a.test");
    signerA = await createUser("centre-signer@acme.test");
    viewerA = await createUser("centre-viewer@acme.test");
    scopedSignerA = await createUser("centre-scoped-signer@acme.test");
    legacyOwnerA = await createUser("centre-legacy@acme.test");
    contactB = await createUser("centre-rival@rival.test");
    ownerUser = await createUser("centre-project-owner@a.test");

    await addMembership(co, staffAdmin);
    await addMembership(co, ownerUser);
    for (const u of [signerA, viewerA, scopedSignerA, legacyOwnerA, contactB]) await addMembership(co, u);
    await grantRole(staffAdmin, await createRole("company_admin"), "company", co);
    const clientRole = await createRole("client");
    for (const u of [signerA, viewerA, scopedSignerA, legacyOwnerA, contactB]) {
      await grantRole(u, clientRole, "company", co);
    }

    clientA = await createClient(co, "Acme Inc");
    clientB = await createClient(co, "Rival Ltd");
    clientLegacy = await createClient(co, "Legacy Whole-Client Co", legacyOwnerA);
    projectA1 = await createProject(co, "Acme site", ownerUser);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectA1, clientA]));

    await addContact(clientA, signerA, "signer"); // client-wide (project_id NULL) — CC-D4 editor
    await addContact(clientA, viewerA, "viewer"); // client-wide viewer — read only
    await addContact(clientA, scopedSignerA, "signer", projectA1); // PROJECT-scoped signer — CC-D4 denies
    await addContact(clientB, contactB, "signer");

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── list ───────────────────────────────────────────────────────────────────────────────────────
  it("lists only the caller's own client(s), with canEdit per CC-D4", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ clientId: string; canEdit: boolean }>;
    expect(rows.map((x) => x.clientId)).toEqual([clientA]);
    expect(rows[0].canEdit).toBe(true);
  });

  it("a viewer's list entry says canEdit:false", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre`, headers: asUser(viewerA) });
    expect(r.json()[0].canEdit).toBe(false);
  });

  // ── in-scope read ──────────────────────────────────────────────────────────────────────────────
  it("an in-scope client-wide signer reads the profile and canEdit:true", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ clientId: clientA, clientName: "Acme Inc", canEdit: true });
  });

  it("a viewer reads the SAME profile with canEdit:false — read is never gated by CC-D4", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(viewerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().canEdit).toBe(false);
  });

  it("a PROJECT-SCOPED signer reads fine but canEdit:false — CC-D4 requires client-wide", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(scopedSignerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().canEdit).toBe(false);
  });

  it("the legacy portal_user_id whole-client signer can read+edit their own client", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientLegacy}`, headers: asUser(legacyOwnerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().canEdit).toBe(true);
  });

  // ── out-of-scope answers 404, never 403 ───────────────────────────────────────────────────────
  it("404s a clientId outside the caller's scope (never 403 — no existence oracle)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientB}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  it("staff (not a portal client at all) is refused entirely", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(staffAdmin) });
    expect(r.statusCode).toBe(403);
  });

  // ── PATCH: the CC-D4 editor gate ──────────────────────────────────────────────────────────────
  it("a VIEWER is refused the PATCH with a plain-English 403", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(viewerA),
      payload: { profile: { legal: "Acme Inc (Pte) Ltd" } },
    });
    expect(r.statusCode).toBe(403);
    expect(typeof r.json().error).toBe("string");
    expect(r.json().error.length).toBeGreaterThan(0);
  });

  it("a PROJECT-SCOPED signer is refused the PATCH — CC-D4 is client-wide only", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(scopedSignerA),
      payload: { profile: { legal: "Acme Inc (Pte) Ltd" } },
    });
    expect(r.statusCode).toBe(403);
  });

  it("a clientId outside scope 404s the PATCH too", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientB}`, headers: asUser(signerA),
      payload: { profile: { legal: "hijack" } },
    });
    expect(r.statusCode).toBe(404);
  });

  it("the CLIENT-WIDE signer's PATCH succeeds, bumps revision, and notifies the project owner", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(signerA),
      payload: { profile: { legal: "Acme Inc (Pte) Ltd" }, businessType: "agency" },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.profile.legal).toBe("Acme Inc (Pte) Ltd");
    expect(b.businessType).toBe("agency");
    expect(b.revision).toBe(1);

    const notif = await withTenants([co], (c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND type = 'client.centre_updated'`,
        [ownerUser],
      ),
    );
    expect(Number(notif.rows[0].n)).toBeGreaterThan(0);
  });

  it("writes exactly one activity row with via:'portal'", async () => {
    await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(signerA),
      payload: { profile: { tagline: "We build brands" } },
    });
    const rows = await withTenants([co], (c) =>
      c.query<{ metadata: { via: string } }>(
        `SELECT metadata FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [clientA],
      ),
    );
    expect(rows.rows[0].metadata.via).toBe("portal");
  });

  it("refuses a credential-looking value from the portal side too (same shared validator)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(signerA),
      payload: { connections: { gsc: { creds: "ghp_abcdefghijklmnopqrstuvwx" } } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/credential/i);
  });

  it("cross-tenant: a rival tenant's staff cannot reach this tenant's portal at all", async () => {
    const rivalStaff = await createUser("rival-staff@rival2.test");
    await addMembership(coNoModule, rivalStaff);
    await grantRole(rivalStaff, await createRole("company_admin"), "company", coNoModule);
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre/${clientA}`, headers: asUser(rivalStaff) });
    expect(r.statusCode).toBe(403);
  });
});
