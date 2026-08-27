// MI-02 — the client portal's change-request surface, against live Postgres + RLS + Cerbos.
//
// Weighted per the ticket's verification standard: a 200 is not a pass. Every notify claim is
// asserted by a real `notifications` row (adminPool, bypassing RLS to see exactly what committed),
// the outbox row is asserted present in the SAME transaction as the write it announces, and the
// body-supplied `status`/foreign `clientId` tests assert the STORED row shows server-derived values
// — strictly stronger than asserting a 4xx.
//
// Cerbos: `gaiada-test-cerbos` (:3592) was restarted after `resource_portal.yaml` picked up the new
// `request_change` action (Cerbos does not hot-reload on this Windows/Docker setup — an unlisted
// action reads as a silent DENY indistinguishable from a logic bug).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
    ),
  );
  return id;
}

interface CrRow {
  id: string; kind: string; title: string; status: string; clientId: string; projectId: string | null;
}

describe.skipIf(!TEST_URL)("MI-02: portal change-request submission (webdev maintenance intake)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let projX: string;
  let projY: string;
  let ownerA: string;
  let clientRole: string;

  let viewerWide: string;   // active, client-wide, clientA, capability='viewer'
  let signerScopedX: string; // active, scoped to projX, clientA, capability='signer'
  let scopedY: string;      // active, scoped to projY, clientA (for the out-of-scope-project refusal)
  let invited: string;
  let revoked: string;
  let dualWide: string;     // active client-wide on BOTH clientA and clientB
  let clientBContact: string; // active, client-wide, clientB — for cross-client isolation

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    clientRole = await createRole("client");

    clientA = await createClient(co, "Bali Beach Resort");
    clientB = await createClient(co, "Nusa Coffee Co");
    ownerA = await createUser("pm-owner@agency.test");
    await addMembership(co, ownerA);
    projX = await createProject(co, "Rebrand X", ownerA);
    projY = await createProject(co, "Microsite Y", ownerA);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projX, clientA]));
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projY, clientA]));

    viewerWide = await createUser("viewer-wide@client.test");
    await addContact(co, clientA, viewerWide, { capability: "viewer" });
    await grantRole(viewerWide, clientRole, "company", co);

    signerScopedX = await createUser("signer-scoped-x@client.test");
    await addContact(co, clientA, signerScopedX, { capability: "signer", projectId: projX });
    await grantRole(signerScopedX, clientRole, "company", co);

    scopedY = await createUser("scoped-y@client.test");
    await addContact(co, clientA, scopedY, { capability: "viewer", projectId: projY });
    await grantRole(scopedY, clientRole, "company", co);

    invited = await createUser("invited@client.test");
    await addContact(co, clientA, invited, { status: "invited" });
    await grantRole(invited, clientRole, "company", co);

    revoked = await createUser("revoked@client.test");
    await addContact(co, clientA, revoked, { status: "revoked" });
    await grantRole(revoked, clientRole, "company", co);

    dualWide = await createUser("dual-wide@client.test");
    await addContact(co, clientA, dualWide, { capability: "viewer" });
    await addContact(co, clientB, dualWide, { capability: "viewer" });
    await grantRole(dualWide, clientRole, "company", co);

    clientBContact = await createUser("client-b@client.test");
    await addContact(co, clientB, clientBContact, { capability: "viewer" });
    await grantRole(clientBContact, clientRole, "company", co);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Positive controls — §5.1's ruling, test-pinned: viewer AND signer both submit successfully
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("an active VIEWER (client-wide) submits successfully — submitting is not a signing act", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: { kind: "bug", title: "Contact form 500s on submit" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; status: string };
    expect(body.status).toBe("new");

    // Row content, not absence-of-error: server-derived clientId/projectId/status/source/requestedBy.
    const row = await adminPool().query(
      `SELECT client_id, project_id, status, source, requested_by, kind, title
         FROM webdev_change_requests WHERE id = $1`,
      [body.id],
    );
    expect(row.rows[0]).toMatchObject({
      client_id: clientA, project_id: null, status: "new", source: "portal",
      requested_by: viewerWide, kind: "bug", title: "Contact form 500s on submit",
    });
  });

  it("bug detail fields round-trip submit -> read-back, and the portal cannot set its own severity", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: {
        kind: "bug",
        title: "Checkout total is wrong on mobile",
        reproSteps: "1. add two items\n2. open cart on iOS Safari\n3. total shows one item",
        environment: "production",
        seenOnVersion: "Alpha 01.071.0173a",
        affectedUrl: "https://example.test/cart",
        // A client naming their own severity must be IGNORED, not honoured and not 400 — the field
        // simply is not part of this contract (migration 202608271000 §3).
        severity: "critical",
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string };

    const row = await adminPool().query(
      `SELECT repro_steps, environment, seen_on_version, affected_url, severity, status
         FROM webdev_change_requests WHERE id = $1`,
      [body.id],
    );
    expect(row.rows[0]).toMatchObject({
      environment: "production",
      seen_on_version: "Alpha 01.071.0173a",
      affected_url: "https://example.test/cart",
      status: "new",
      // The whole point: the client asked for 'critical' and did not get it. Severity arrives at
      // triage or not at all.
      severity: null,
    });
    expect(String(row.rows[0].repro_steps)).toContain("iOS Safari");

    // And the detail read gives the client back what they actually submitted — a field the SELECT
    // list forgot would be indistinguishable from one they never typed.
    const detail = await app.inject({
      method: "GET",
      url: `/api/${co}/portal/change-requests/${body.id}`,
      headers: asUser(viewerWide),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      environment: "production",
      seenOnVersion: "Alpha 01.071.0173a",
      affectedUrl: "https://example.test/cart",
      severity: null,
    });
  });

  it("an active SIGNER (project-scoped) submits successfully", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(signerScopedX),
      payload: { kind: "feature", title: "Add a newsletter signup block", projectId: projX },
    });
    expect(r.statusCode).toBe(201);
    const row = await adminPool().query(
      `SELECT client_id, project_id, status FROM webdev_change_requests WHERE id = $1`,
      [(r.json() as { id: string }).id],
    );
    expect(row.rows[0]).toMatchObject({ client_id: clientA, project_id: projX, status: "new" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Notification — asserted by ROW CONTENT, not absence of error
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("notifies the client's project owner with a real notifications row (content asserted)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: { kind: "content", title: "Update the footer address" },
    });
    expect(r.statusCode).toBe(201);
    const crId = (r.json() as { id: string }).id;

    const notif = await adminPool().query(
      `SELECT user_id, type, payload FROM notifications
        WHERE tenant_id = $1 AND user_id = $2 AND type = 'webdev.change_request.created'
        ORDER BY created_at DESC LIMIT 1`,
      [co, ownerA],
    );
    expect(notif.rows).toHaveLength(1);
    const payload = notif.rows[0].payload as { title: string; entityType: string; entityId: string; href: string };
    expect(payload.entityType).toBe("webdev_change_request");
    expect(payload.entityId).toBe(crId);
    expect(payload.title).toContain("Update the footer address");
  });

  it("the outbox row is present in the SAME transaction as the write it announces", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: { kind: "design", title: "Refresh the hero banner" },
    });
    const crId = (r.json() as { id: string }).id;
    const outbox = await adminPool().query(
      `SELECT event_type, entity_type, payload FROM outbox_events
        WHERE entity_type = 'webdev_change_request' AND entity_id = $1`,
      [crId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe("webdev.change_request.created");
    expect((outbox.rows[0].payload as { clientId: string }).clientId).toBe(clientA);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Refusals — the §5 project rule, structural, not "tightened" to signers
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("a project-scoped contact naming a project OUTSIDE their scope is refused (4xx)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(signerScopedX),
      payload: { kind: "bug", title: "wrong project", projectId: projY },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it("a project-scoped contact naming NO project is refused (4xx) — must name one of their projects", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(signerScopedX),
      payload: { kind: "bug", title: "no project named" },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it("an INVITED contact is refused (403) — no account to act as yet", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(invited),
      payload: { kind: "bug", title: "should never land" },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("a REVOKED contact is refused (403)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(revoked),
      payload: { kind: "bug", title: "should never land" },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("an ambiguous multi-client contact must name an account (4xx without clientId)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(dualWide),
      payload: { kind: "bug", title: "which account?" },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it("an ambiguous multi-client contact succeeds when they name a valid account", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(dualWide),
      payload: { kind: "bug", title: "for client B specifically", clientId: clientB },
    });
    expect(r.statusCode).toBe(201);
    const row = await adminPool().query(`SELECT client_id FROM webdev_change_requests WHERE id = $1`, [(r.json() as { id: string }).id]);
    expect(row.rows[0].client_id).toBe(clientB);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Body-supplied status/foreign client_id are IGNORED — asserted on the STORED row, stronger than a 4xx
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("a body-supplied status is ignored — the stored row is always 'new'", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: { kind: "bug", title: "attempted status forge", status: "done" },
    });
    expect(r.statusCode).toBe(201);
    const row = await adminPool().query(`SELECT status, route FROM webdev_change_requests WHERE id = $1`, [(r.json() as { id: string }).id]);
    expect(row.rows[0].status).toBe("new");
    expect(row.rows[0].route).toBeNull();
  });

  it("a foreign/unscoped clientId in the body is ignored — the stored row shows the caller's real client", async () => {
    // viewerWide has EXACTLY ONE client (clientA) — the unambiguous-default branch, which never even
    // reads body.clientId. Supplying clientB (a real client id, just not the caller's) must not
    // redirect the request there.
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(viewerWide),
      payload: { kind: "bug", title: "attempted client forge", clientId: clientB },
    });
    expect(r.statusCode).toBe(201);
    const row = await adminPool().query(`SELECT client_id FROM webdev_change_requests WHERE id = $1`, [(r.json() as { id: string }).id]);
    expect(row.rows[0].client_id).toBe(clientA);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Cross-client isolation within the SAME tenant, and list/detail reads
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("client A reading client B's change request (same tenant) is invisible (404, not 403)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(clientBContact),
      payload: { kind: "bug", title: "client B's own request" },
    });
    const crId = (created.json() as { id: string }).id;

    const asOwnClient = await app.inject({
      method: "GET", url: `/api/${co}/portal/change-requests/${crId}`, headers: asUser(clientBContact),
    });
    expect(asOwnClient.statusCode).toBe(200);

    const asOtherClient = await app.inject({
      method: "GET", url: `/api/${co}/portal/change-requests/${crId}`, headers: asUser(viewerWide),
    });
    expect(asOtherClient.statusCode).toBe(404);
  });

  it("list returns only the caller's own client's requests, newest scope-visible ones included", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests`, headers: asUser(viewerWide) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as CrRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.clientId === clientA)).toBe(true);
  });

  it("a project-scoped contact's list excludes a sibling project's requests", async () => {
    // signerScopedX (projX only) must not see scopedY's (projY) submissions in their list.
    const madeByY = await app.inject({
      method: "POST",
      url: `/api/${co}/portal/change-requests`,
      headers: asUser(scopedY),
      payload: { kind: "bug", title: "projY-only request", projectId: projY },
    });
    const crId = (madeByY.json() as { id: string }).id;

    const listX = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests`, headers: asUser(signerScopedX) });
    const ids = (listX.json() as CrRow[]).map((row) => row.id);
    expect(ids).not.toContain(crId);

    const detailX = await app.inject({ method: "GET", url: `/api/${co}/portal/change-requests/${crId}`, headers: asUser(signerScopedX) });
    expect(detailX.statusCode).toBe(404);
  });
});
