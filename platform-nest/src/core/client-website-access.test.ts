// WSK-49f / WSK-D60 (amended) -- the client_website_editor grant path, over HTTP against live PG + RLS + Cerbos.
//
// DENIAL TESTS SEND VALID BODIES. Validation must never pre-empt authorization: a denial test whose body
// would have been refused as malformed anyway proves nothing about Cerbos (validation-preempts-authz). Every
// 403 below is therefore asserted on a request that would SUCCEED for an allowed caller, and most are paired
// with a positive control on the same target.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withGlobal, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addContact(
  tenantId: string, clientId: string, userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "viewer", opts.status ?? "active", config.originSite],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("WSK-49f: client_website_editor grant path (staff + client admin), bounded and audited", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let clientRole: string;
  let companyAdminRole: string;

  // staff
  let companyAdmin: string;
  let manager: string;
  let plainMember: string;
  let otherAdmin: string;
  // clients
  let clientA: string;
  let clientB: string;
  let clientX: string; // in the OTHER company
  // client-side people (users)
  let adminA: string; // capability admin, clientA
  let signerA: string;
  let viewerA: string;
  let targetA: string; // viewer, clientA: the grantee in most tests
  let target2A: string;
  let adminB: string;
  let contactB: string;
  let scopedA: string; // project-scoped row on clientA
  let revokedA: string;
  let contactX: string;
  // contact row ids
  const cid: Record<string, string> = {};

  const url = {
    staffEditor: (c: string, k: string, t = co) => `/api/${t}/clients/${c}/contacts/${k}/website-editor`,
    staffAdmin: (c: string, k: string, t = co) => `/api/${t}/clients/${c}/contacts/${k}/admin`,
    staffList: (c: string, t = co) => `/api/${t}/clients/${c}/website-access`,
    portalEditor: (c: string, k: string, t = co) => `/api/${t}/portal/clients/${c}/contacts/${k}/website-editor`,
    portalList: (c: string, t = co) => `/api/${t}/portal/clients/${c}/website-access`,
  };

  const grantsOf = async (userId: string) =>
    (
      await adminPool().query<{ name: string; scope_type: string; scope_id: string }>(
        `SELECT r.name, ur.scope_type, ur.scope_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [userId],
      )
    ).rows;
  const editorRows = async (userId: string) => (await grantsOf(userId)).filter((g) => g.name === "client_website_editor");
  const auditRows = async (contactId: string, verbLike: string) =>
    (
      await adminPool().query<{ actor_id: string; verb: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, verb, metadata FROM activities WHERE target_entity_id = $1 AND verb LIKE $2 ORDER BY occurred_at, id`,
        [contactId, verbLike],
      )
    ).rows;
  const clearGrants = async () => {
    await adminPool().query(`DELETE FROM user_roles WHERE scope_type = 'client'`);
  };
  const setCapability = async (contactId: string, capability: string, status = "active") => {
    await adminPool().query(`UPDATE client_contacts SET capability = $2, status = $3 WHERE id = $1`, [contactId, capability, status]);
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    clientRole = await createRole("client");
    companyAdminRole = await createRole("company_admin");
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");

    companyAdmin = await createUser("ca@w49f.test");
    manager = await createUser("mgr@w49f.test");
    plainMember = await createUser("mem@w49f.test");
    otherAdmin = await createUser("oa@w49f.test");
    for (const u of [companyAdmin, manager, plainMember]) await addMembership(co, u);
    await addMembership(other, otherAdmin);
    await grantRole(companyAdmin, companyAdminRole, "company", co);
    await grantRole(manager, managerRole, "company", co);
    await grantRole(plainMember, memberRole, "company", co);
    await grantRole(otherAdmin, companyAdminRole, "company", other);

    clientA = await createClient(co, "Bali Beach Resort");
    clientB = await createClient(co, "Nusa Coffee Co");
    clientX = await createClient(other, "Rival Client");
    const projA = await createProject(co, "Rebrand A");
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projA, clientA]));

    const mk = async (email: string, tenant: string, client: string, opts: Parameters<typeof addContact>[3] = {}) => {
      const u = await createUser(email);
      const id = await addContact(tenant, client, u, opts);
      await grantRole(u, clientRole, "company", tenant);
      cid[email] = id;
      return u;
    };
    adminA = await mk("admin-a@w49f.test", co, clientA, { capability: "admin" });
    signerA = await mk("signer-a@w49f.test", co, clientA, { capability: "signer" });
    viewerA = await mk("viewer-a@w49f.test", co, clientA, { capability: "viewer" });
    targetA = await mk("target-a@w49f.test", co, clientA, { capability: "viewer" });
    target2A = await mk("target2-a@w49f.test", co, clientA, { capability: "viewer" });
    adminB = await mk("admin-b@w49f.test", co, clientB, { capability: "admin" });
    contactB = await mk("contact-b@w49f.test", co, clientB, { capability: "viewer" });
    scopedA = await mk("scoped-a@w49f.test", co, clientA, { capability: "viewer", projectId: projA });
    revokedA = await mk("revoked-a@w49f.test", co, clientA, { capability: "viewer", status: "revoked" });
    contactX = await mk("contact-x@w49f.test", other, clientX, { capability: "viewer" });

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════ STAFF ════════════════════════════
  describe("staff: PUT/DELETE .../contacts/:contactId/website-editor", () => {
    it("a company_admin grants; ONE grant row (client scope, this client) and ONE audit row naming the actor", async () => {
      await clearGrants();
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ websiteEditor: true, changed: true, role: "client_website_editor", clientId: clientA, userId: targetA });
      expect(await grantsOf(targetA)).toEqual([
        { name: "client", scope_type: "company", scope_id: co },
        { name: "client_website_editor", scope_type: "client", scope_id: clientA },
      ]);
      const audit = await auditRows(cid["target-a@w49f.test"], "client_website_editor.%");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: companyAdmin, verb: "client_website_editor.granted" });
      expect(audit[0].metadata).toMatchObject({ clientId: clientA, targetUserId: targetA, role: "client_website_editor", surface: "staff", actorKind: "staff" });
    });

    it("granting twice is a no-op 200 (changed:false) with NO second grant row and NO second audit row", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ websiteEditor: true, changed: false });
      expect(await editorRows(targetA)).toHaveLength(1);
      expect(await auditRows(cid["target-a@w49f.test"], "client_website_editor.%")).toHaveLength(1);
    });

    it("the access list shows the holder (staff GET)", async () => {
      const r = await app.inject({ method: "GET", url: url.staffList(clientA), headers: asUser(plainMember) });
      expect(r.statusCode).toBe(200);
      const rows = r.json().contacts as Array<{ userId: string; websiteEditor: boolean; isAdmin: boolean; capability: string }>;
      expect(rows.find((x) => x.userId === targetA)?.websiteEditor).toBe(true);
      expect(rows.find((x) => x.userId === adminA)?.isAdmin).toBe(true);
      expect(rows.find((x) => x.userId === viewerA)?.websiteEditor).toBe(false);
      // revoked and project-scoped rows are not eligible and are not listed
      expect(rows.some((x) => x.userId === revokedA || x.userId === scopedA)).toBe(false);
    });

    it("revoke removes the grant and writes ONE audit row; revoking again is a no-op with no audit row", async () => {
      const r = await app.inject({ method: "DELETE", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ websiteEditor: false, changed: true });
      expect(await editorRows(targetA)).toHaveLength(0);
      const again = await app.inject({ method: "DELETE", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ changed: false });
      const audit = await auditRows(cid["target-a@w49f.test"], "client_website_editor.%");
      expect(audit.map((a) => a.verb)).toEqual(["client_website_editor.granted", "client_website_editor.revoked"]);
      expect(audit[1].actor_id).toBe(companyAdmin);
    });

    it("a manager (client-write tier) may grant too (positive control)", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target2-a@w49f.test"]), headers: asUser(manager) });
      expect(r.statusCode).toBe(200);
      expect((await auditRows(cid["target2-a@w49f.test"], "client_website_editor.granted"))[0].actor_id).toBe(manager);
      await app.inject({ method: "DELETE", url: url.staffEditor(clientA, cid["target2-a@w49f.test"]), headers: asUser(manager) });
    });

    it("a plain staff member (no client-write rights) is denied, on a VALID target", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(plainMember) });
      expect(r.statusCode).toBe(403);
      expect(await editorRows(targetA)).toHaveLength(0);
    });

    it("STAFF OF A DIFFERENT COMPANY cannot grant on this client: 403 on this tenant's route", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(otherAdmin) });
      expect(r.statusCode).toBe(403);
      expect(await editorRows(targetA)).toHaveLength(0);
    });

    it("...and not through their OWN tenant's route either: the contact is invisible under RLS (404, no grant)", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"], other), headers: asUser(otherAdmin) });
      expect(r.statusCode).toBe(404);
      expect(await editorRows(targetA)).toHaveLength(0);
    });

    it("a contact of ANOTHER client of the same company is a 404, never a write", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["contact-b@w49f.test"]), headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(404);
      expect(await editorRows(contactB)).toHaveLength(0);
    });

    it("a project-scoped contact row cannot hold a client-wide grant (400); a revoked contact neither", async () => {
      const a = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["scoped-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(a.statusCode).toBe(400);
      const b = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["revoked-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(b.statusCode).toBe(400);
      expect(await editorRows(scopedA)).toHaveLength(0);
      expect(await editorRows(revokedA)).toHaveLength(0);
    });

    it("a client admin cannot use the STAFF url (no client arm there): 403 on a valid target of their own client", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(r.statusCode).toBe(403);
      expect(await editorRows(targetA)).toHaveLength(0);
    });
  });

  // ════════════════════════════ admin capability ════════════════════════════
  describe("staff only: PUT/DELETE .../contacts/:contactId/admin", () => {
    it("a company_admin assigns admin to a viewer (audited), idempotently, and can take it away (back to viewer)", async () => {
      const k = cid["target2-a@w49f.test"];
      const put = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ capability: "admin", changed: true });
      const again = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      expect(again.json()).toMatchObject({ changed: false });
      expect((await adminPool().query(`SELECT capability FROM client_contacts WHERE id = $1`, [k])).rows[0].capability).toBe("admin");
      const audit = await auditRows(k, "client_contact.admin_%");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: companyAdmin, verb: "client_contact.admin_granted" });
      expect(audit[0].metadata).toMatchObject({ previousCapability: "viewer" });
      const del = await app.inject({ method: "DELETE", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      expect(del.json()).toMatchObject({ capability: "viewer", changed: true });
      expect((await auditRows(k, "client_contact.admin_%")).map((a) => a.verb)).toEqual(["client_contact.admin_granted", "client_contact.admin_revoked"]);
    });

    it("promoting a SIGNER is refused (409) unless explicitly confirmed, because admin replaces signer", async () => {
      const k = cid["signer-a@w49f.test"];
      const a = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      expect(a.statusCode).toBe(409);
      expect((await adminPool().query(`SELECT capability FROM client_contacts WHERE id = $1`, [k])).rows[0].capability).toBe("signer");
      const b = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), payload: { confirmReplaceSigner: true }, headers: asUser(companyAdmin) });
      expect(b.statusCode).toBe(200);
      await setCapability(k, "signer"); // restore for the other tests
    });

    it("a manager may NOT assign admin (company_admin tier only), on a valid target", async () => {
      const r = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, cid["target-a@w49f.test"]), headers: asUser(manager) });
      expect(r.statusCode).toBe(403);
    });

    it("a CLIENT ADMIN cannot assign admin (to anyone, including themselves or a colleague)", async () => {
      for (const k of [cid["target-a@w49f.test"], cid["admin-a@w49f.test"], cid["viewer-a@w49f.test"]]) {
        const r = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(adminA) });
        expect(r.statusCode).toBe(403);
      }
      expect((await adminPool().query(`SELECT capability FROM client_contacts WHERE id = $1`, [cid["target-a@w49f.test"]])).rows[0].capability).toBe("viewer");
    });

    it("a signer, a viewer and another company's admin cannot assign admin either", async () => {
      for (const who of [signerA, viewerA, otherAdmin]) {
        const r = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, cid["target-a@w49f.test"]), headers: asUser(who) });
        expect(r.statusCode).toBe(403);
      }
    });
  });

  // ════════════════════════════ PORTAL: the client admin ════════════════════════════
  describe("portal: a client admin grants website-editor to contacts of their OWN client", () => {
    it("grants and revokes, with the right actor and surface in the audit rows", async () => {
      await clearGrants();
      const n0 = (await auditRows(cid["target-a@w49f.test"], "client_website_editor.%")).length; // earlier staff tests audited this contact too
      const put = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ websiteEditor: true, changed: true, userId: targetA });
      expect(await editorRows(targetA)).toEqual([{ name: "client_website_editor", scope_type: "client", scope_id: clientA }]);
      const audit = (await auditRows(cid["target-a@w49f.test"], "client_website_editor.%")).slice(n0);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: adminA, verb: "client_website_editor.granted" });
      expect(audit[0].metadata).toMatchObject({ surface: "portal", actorKind: "client_admin", clientId: clientA });

      const dup = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(dup.json()).toMatchObject({ changed: false });
      expect((await auditRows(cid["target-a@w49f.test"], "client_website_editor.%")).slice(n0)).toHaveLength(1);

      const del = await app.inject({ method: "DELETE", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(del.json()).toMatchObject({ websiteEditor: false, changed: true });
      expect(await editorRows(targetA)).toHaveLength(0);
      const all = (await auditRows(cid["target-a@w49f.test"], "client_website_editor.%")).slice(n0);
      expect(all.map((a) => [a.verb, a.actor_id])).toEqual([["client_website_editor.granted", adminA], ["client_website_editor.revoked", adminA]]);
    });

    it("the portal list shows only this client's eligible contacts", async () => {
      const r = await app.inject({ method: "GET", url: url.portalList(clientA), headers: asUser(adminA) });
      expect(r.statusCode).toBe(200);
      const ids = (r.json().contacts as Array<{ userId: string }>).map((x) => x.userId);
      expect(ids).toEqual(expect.arrayContaining([adminA, signerA, viewerA, targetA]));
      expect(ids).not.toContain(contactB);
      expect(ids).not.toContain(revokedA);
      expect(ids).not.toContain(scopedA);
    });

    it("BOUND: a client admin cannot grant ANY other role or permission, whatever the body says", async () => {
      await clearGrants();
      const before = await grantsOf(targetA);
      const r = await app.inject({
        method: "PUT",
        url: url.portalEditor(clientA, cid["target-a@w49f.test"]),
        headers: asUser(adminA),
        payload: { role: "company_admin", roleId: companyAdminRole, scopeType: "company", scopeId: co, permissions: ["core.client.read", "core.user.create"], capability: "admin" },
      });
      expect(r.statusCode).toBe(200);
      // exactly ONE new row, the website editor at client scope: the body was never read as a role or a scope
      const after = await grantsOf(targetA);
      expect(after.filter((g) => !before.some((b) => b.name === g.name && b.scope_id === g.scope_id))).toEqual([
        { name: "client_website_editor", scope_type: "client", scope_id: clientA },
      ]);
      expect((await adminPool().query(`SELECT capability FROM client_contacts WHERE id = $1`, [cid["target-a@w49f.test"]])).rows[0].capability).toBe("viewer");
      await app.inject({ method: "DELETE", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
    });

    it("BOUND: there is no portal route for admin or any other role (404), and the staff admin route is 403", async () => {
      const k = cid["target-a@w49f.test"];
      const a = await app.inject({ method: "PUT", url: `/api/${co}/portal/clients/${clientA}/contacts/${k}/admin`, headers: asUser(adminA) });
      expect(a.statusCode).toBe(404);
      const b = await app.inject({ method: "PUT", url: `/api/${co}/portal/clients/${clientA}/contacts/${k}/company_admin`, headers: asUser(adminA) });
      expect(b.statusCode).toBe(404);
      const c = await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(adminA) });
      expect(c.statusCode).toBe(403);
    });

    it("BOUND: a client admin cannot use the generic grant surfaces (VALID bodies, a real staff target): 403", async () => {
      // role_grants: a valid body naming a real staff member and the company_admin role
      const rg = await app.inject({
        method: "POST", url: `/api/${co}/role-grants`, headers: asUser(adminA),
        payload: { userId: plainMember, roleId: companyAdminRole, scopeType: "company" },
      });
      expect(rg.statusCode).toBe(403);
      expect((await grantsOf(plainMember)).some((g) => g.name === "company_admin")).toBe(false);
      // inviting a contact as a signer (create is manager tier)
      const inv = await app.inject({
        method: "POST", url: `/api/${co}/clients/${clientA}/contacts`, headers: asUser(adminA),
        payload: { email: "fresh@w49f.test", name: "Fresh", capability: "signer" },
      });
      expect(inv.statusCode).toBe(403);
      // reading the role-grant list
      const list = await app.inject({ method: "GET", url: `/api/${co}/role-grants?userId=${plainMember}`, headers: asUser(adminA) });
      expect(list.statusCode).toBe(403);
    });

    it("BOUND: cannot grant to a contact of ANOTHER client (404), nor to a user outside their client", async () => {
      // contact id of clientB under clientA's URL
      const a = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["contact-b@w49f.test"]), headers: asUser(adminA) });
      expect(a.statusCode).toBe(404);
      // a contact of the OTHER company, under this tenant's route
      const b = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["contact-x@w49f.test"]), headers: asUser(adminA) });
      expect(b.statusCode).toBe(404);
      // an id that is no contact at all (a staff user's id, a random uuid)
      const c = await app.inject({ method: "PUT", url: url.portalEditor(clientA, plainMember), headers: asUser(adminA) });
      expect(c.statusCode).toBe(404);
      const d = await app.inject({ method: "PUT", url: url.portalEditor(clientA, newId()), headers: asUser(adminA) });
      expect(d.statusCode).toBe(404);
      expect(await editorRows(contactB)).toHaveLength(0);
      expect(await editorRows(contactX)).toHaveLength(0);
      expect(await editorRows(plainMember)).toHaveLength(0);
    });

    it("BOUND (ceiling): an admin of clientA cannot act on clientB, even for clientB's own contact (403)", async () => {
      const a = await app.inject({ method: "PUT", url: url.portalEditor(clientB, cid["contact-b@w49f.test"]), headers: asUser(adminA) });
      expect(a.statusCode).toBe(403);
      const b = await app.inject({ method: "GET", url: url.portalList(clientB), headers: asUser(adminA) });
      expect(b.statusCode).toBe(403);
      const c = await app.inject({ method: "DELETE", url: url.portalEditor(clientB, cid["contact-b@w49f.test"]), headers: asUser(adminA) });
      expect(c.statusCode).toBe(403);
      // positive control: clientB's own admin may
      const ok = await app.inject({ method: "PUT", url: url.portalEditor(clientB, cid["contact-b@w49f.test"]), headers: asUser(adminB) });
      expect(ok.statusCode).toBe(200);
      await clearGrants();
    });

    it("BOUND: an admin cannot grant the role to THEMSELVES (self-escalation refused, 400)", async () => {
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["admin-a@w49f.test"]), headers: asUser(adminA) });
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.json())).toMatch(/self_grant_forbidden/);
      expect(await editorRows(adminA)).toHaveLength(0);
    });

    it("BOUND: a SIGNER and a VIEWER (not admin) cannot grant, on a valid target of their own client", async () => {
      for (const who of [signerA, viewerA]) {
        const put = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(who) });
        expect(put.statusCode).toBe(403);
        const list = await app.inject({ method: "GET", url: url.portalList(clientA), headers: asUser(who) });
        expect(list.statusCode).toBe(403);
      }
      expect(await editorRows(targetA)).toHaveLength(0);
      // positive control: the same request succeeds for the admin
      const ok = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(ok.statusCode).toBe(200);
      await clearGrants();
    });

    it("a website editor (holds the role, not admin) cannot grant it onward", async () => {
      await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target2-a@w49f.test"]), headers: asUser(targetA) });
      expect(r.statusCode).toBe(403);
      expect(await editorRows(target2A)).toHaveLength(0);
      await clearGrants();
    });

    it("STAFF on the portal route fail the portal scope check (not a contact of the client): 403, no grant", async () => {
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(403);
      expect(await editorRows(targetA)).toHaveLength(0);
    });

    it("staff of a different company on the portal route: 403", async () => {
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(otherAdmin) });
      expect(r.statusCode).toBe(403);
    });

    it("an admin whose capability is withdrawn (staff DELETE admin) loses the power on the very next call", async () => {
      const k = cid["admin-a@w49f.test"];
      const ok = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(ok.statusCode).toBe(200);
      await app.inject({ method: "DELETE", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      const denied = await app.inject({ method: "DELETE", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(adminA) });
      expect(denied.statusCode).toBe(403);
      expect(await editorRows(targetA)).toHaveLength(1); // the grant they made stays until revoked by someone allowed
      await app.inject({ method: "PUT", url: url.staffAdmin(clientA, k), headers: asUser(companyAdmin) });
      await clearGrants();
    });

    it("a REVOKED admin contact has no power (status governs access)", async () => {
      const k = cid["admin-b@w49f.test"];
      await setCapability(k, "admin", "revoked");
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientB, cid["contact-b@w49f.test"]), headers: asUser(adminB) });
      expect(r.statusCode).toBe(403);
      await setCapability(k, "admin", "active");
    });

    it("a project-scoped ADMIN row confers nothing (admin is client-wide)", async () => {
      const u = await createUser("pscoped-admin@w49f.test");
      const p = (await adminPool().query<{ id: string }>(`SELECT id FROM projects WHERE tenant_id = $1 LIMIT 1`, [co])).rows[0].id;
      await addContact(co, clientA, u, { capability: "admin", projectId: p });
      await grantRole(u, clientRole, "company", co);
      const r = await app.inject({ method: "PUT", url: url.portalEditor(clientA, cid["target-a@w49f.test"]), headers: asUser(u) });
      expect(r.statusCode).toBe(403);
    });
  });

  // ════════════════════════════ lifecycle ════════════════════════════
  describe("lifecycle", () => {
    it("revoking the contact (existing endpoint) deletes their website-editor grant and audits it", async () => {
      await clearGrants();
      const n0 = (await auditRows(cid["target2-a@w49f.test"], "client_website_editor.%")).length;
      await app.inject({ method: "PUT", url: url.staffEditor(clientA, cid["target2-a@w49f.test"]), headers: asUser(companyAdmin) });
      expect(await editorRows(target2A)).toHaveLength(1);
      const r = await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${cid["target2-a@w49f.test"]}/revoke`, headers: asUser(companyAdmin) });
      expect(r.statusCode).toBe(200);
      expect(await editorRows(target2A)).toHaveLength(0);
      const audit = (await auditRows(cid["target2-a@w49f.test"], "client_website_editor.%")).slice(n0);
      expect(audit.map((a) => a.verb)).toEqual(["client_website_editor.granted", "client_website_editor.revoked"]);
      expect(audit[1].metadata).toMatchObject({ reason: "contact_revoked" });
      expect(audit[1].actor_id).toBe(companyAdmin);
    });

    it("every change has exactly one audit row (no grant exists without its audit row)", async () => {
      const { rows } = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.name = 'client_website_editor'
            AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.verb = 'client_website_editor.granted'
                              AND (a.metadata->>'targetUserId') = ur.user_id::text)`,
      );
      expect(rows[0].n).toBe(0);
    });
  });

  // keep the unused-import linter honest
  void withGlobal;
});
