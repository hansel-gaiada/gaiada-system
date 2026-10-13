// WSK-49f / WSK-D60 -- the grant-write choke point's client scope, and what assemblePrincipal() does with a
// client-scoped grant and with the `admin` capability. DB-backed (RLS-bound pools), no Cerbos needed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { principalPayload } from "../rbac/cerbos";
import {
  assertGrantAllowed, grantClientWebsiteEditor, insertGrantRow, revokeClientWebsiteEditor, type GrantOrigin,
} from "./grant-write.service";
import { assertRoleScopeAllowed } from "./admin-identity.controller";

async function addContact(
  tenantId: string, clientId: string, userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null; deleted?: boolean } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "viewer", opts.status ?? "active", config.originSite, opts.deleted ? new Date() : null],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("WSK-49f: client-scoped grants in the choke point and in assemblePrincipal()", () => {
  let co: string;
  let other: string;
  let clientA: string;
  let clientB: string;
  let clientX: string;
  let editorRole: string;
  let staffRole: string;
  let actor: string;

  const holds = async (userId: string) =>
    (
      await adminPool().query(
        `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.name = 'client_website_editor'`,
        [userId],
      )
    ).rowCount;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    clientA = await createClient(co, "Client A");
    clientB = await createClient(co, "Client B");
    clientX = await createClient(other, "Client X");
    editorRole = await createRole("client_website_editor"); // seeded by the migration; get-or-create returns it
    staffRole = await createRole("company_admin");
    actor = await createUser("actor@w49f-db.test");
  }, 120_000);
  afterAll(teardownTestDb);

  // ───────────────────────── the choke point ─────────────────────────
  describe("grantClientWebsiteEditor / revokeClientWebsiteEditor", () => {
    it("grants once (row id), then is a no-op (null); revoke deletes once, then is a no-op", async () => {
      const u = await createUser("t1@w49f-db.test");
      await addContact(co, clientA, u);
      const spec = { tenantId: co, clientId: clientA, targetUserId: u, actorUserId: actor, actorVia: "staff" as const };
      const first = await withTenants([co], (c) => grantClientWebsiteEditor(c, spec));
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withTenants([co], (c) => grantClientWebsiteEditor(c, spec))).toBeNull();
      expect(await holds(u)).toBe(1);
      expect(await withTenants([co], (c) => revokeClientWebsiteEditor(c, spec))).toBe(first);
      expect(await withTenants([co], (c) => revokeClientWebsiteEditor(c, spec))).toBeNull();
      expect(await holds(u)).toBe(0);
    });

    it("refuses a target that is not a client-wide, non-revoked contact of THAT client", async () => {
      const spec = (u: string, clientId = clientA) => ({ tenantId: co, clientId, targetUserId: u, actorUserId: actor, actorVia: "staff" as const });
      const stranger = await createUser("stranger@w49f-db.test");
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(stranger)))).rejects.toThrow(/target_not_a_contact_of_client/);
      const ofB = await createUser("ofb@w49f-db.test");
      await addContact(co, clientB, ofB);
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(ofB)))).rejects.toThrow(/target_not_a_contact_of_client/);
      const revoked = await createUser("revoked@w49f-db.test");
      await addContact(co, clientA, revoked, { status: "revoked" });
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(revoked)))).rejects.toThrow(/target_not_a_contact_of_client/);
      const scoped = await createUser("scoped@w49f-db.test");
      const proj = await createProject(co, "w49f scoped", undefined, clientA);
      await addContact(co, clientA, scoped, { projectId: proj });
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(scoped)))).rejects.toThrow(/target_not_a_contact_of_client/);
      const gone = await createUser("deleted@w49f-db.test");
      await addContact(co, clientA, gone, { deleted: true });
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(gone)))).rejects.toThrow(/target_not_a_contact_of_client/);
      for (const u of [stranger, ofB, revoked, scoped, gone]) expect(await holds(u)).toBe(0);
    });

    it("is anchored on the client record: another company's client, or a client id that does not exist, is refused", async () => {
      const u = await createUser("anchor@w49f-db.test");
      await addContact(co, clientA, u);
      const spec = (clientId: string, tenantId = co) => ({ tenantId, clientId, targetUserId: u, actorUserId: actor, actorVia: "staff" as const });
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(clientX)))).rejects.toThrow(/client_not_found/);
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec(newId())))).rejects.toThrow(/client_not_found/);
      // a non-tenant-scoped connection sees no rows at all (RLS) -> fails closed rather than granting
      await expect(withGlobal((c) => grantClientWebsiteEditor(c, spec(clientA)))).rejects.toThrow(/client_not_found/);
      expect(await holds(u)).toBe(0);
    });

    it("refuses a self-grant (the actor is the target), but not a self-REVOKE", async () => {
      const u = await createUser("self@w49f-db.test");
      await addContact(co, clientA, u, { capability: "admin" });
      const spec = { tenantId: co, clientId: clientA, targetUserId: u, actorUserId: u, actorVia: "client_admin" as const, actorClientAdminOf: [{ tenantId: co, clientId: clientA }] };
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, spec))).rejects.toThrow(/self_grant_forbidden/);
      await expect(withTenants([co], (c) => revokeClientWebsiteEditor(c, spec))).resolves.toBeNull();
    });

    it("the CEILING: a client_admin actor must hold admin on THIS exact (tenant, client); nothing else will do", async () => {
      const u = await createUser("ceil@w49f-db.test");
      await addContact(co, clientA, u);
      const base = { tenantId: co, clientId: clientA, targetUserId: u, actorUserId: actor, actorVia: "client_admin" as const };
      for (const held of [undefined, [], [{ tenantId: co, clientId: clientB }], [{ tenantId: other, clientId: clientA }]]) {
        await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, { ...base, actorClientAdminOf: held }))).rejects.toThrow(/ceiling_exceeded/);
        await expect(withTenants([co], (c) => revokeClientWebsiteEditor(c, { ...base, actorClientAdminOf: held }))).rejects.toThrow(/ceiling_exceeded/);
      }
      expect(await holds(u)).toBe(0);
      // positive control
      await expect(withTenants([co], (c) => grantClientWebsiteEditor(c, { ...base, actorClientAdminOf: [{ tenantId: co, clientId: clientA }] }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it("rejects malformed ids before touching a row", async () => {
      await expect(
        withTenants([co], (c) => grantClientWebsiteEditor(c, { tenantId: co, clientId: "nope", targetUserId: actor, actorUserId: null, actorVia: "staff" })),
      ).rejects.toThrow(/uuids/);
    });
  });

  describe("no generic surface can mint a client scope or the role", () => {
    const origins: GrantOrigin[] = ["legacy_admin", "ui", "trusted_internal", "two_person_appointment"];
    it.each(origins)("origin %s: scope_type=client is refused by the guard (trusted_internal included)", async (origin) => {
      const target = await createUser(`gen-${origin}@w49f-db.test`);
      await expect(
        withGlobal((c) =>
          assertGrantAllowed(c, { origin, targetUserId: target, roleId: editorRole, scopeType: "client", scopeId: clientA, actorUserId: actor, tenantId: co, onConflict: "unique_columns" }),
        ),
      ).rejects.toThrow(/client_scope_dedicated_path/);
      await expect(
        withGlobal((c) =>
          insertGrantRow(c, { origin, targetUserId: target, roleId: staffRole, scopeType: "client", scopeId: clientA, actorUserId: actor, tenantId: co, onConflict: "unique_columns" }),
        ),
      ).rejects.toThrow(/client_scope_dedicated_path/);
      expect(await holds(target)).toBe(0);
    });

    it.each(["legacy_admin", "ui"] as GrantOrigin[])("origin %s: the role itself, at company scope, is refused by name", async (origin) => {
      const target = await createUser(`role-${origin}@w49f-db.test`);
      await expect(
        withGlobal((c) =>
          insertGrantRow(c, { origin, targetUserId: target, roleId: editorRole, scopeType: "company", scopeId: co, actorUserId: actor, tenantId: co, onConflict: "unique_columns" }),
        ),
      ).rejects.toThrow(/client_scope_dedicated_path/);
      expect(await holds(target)).toBe(0);
    });

    it("the scope guard map (ROLE_SCOPE_CONSTRAINTS) pins the role to client scope", () => {
      expect(() => assertRoleScopeAllowed("client_website_editor", "company")).toThrow(/only be granted at client scope/);
      expect(() => assertRoleScopeAllowed("client_website_editor", "global")).toThrow();
      expect(() => assertRoleScopeAllowed("client_website_editor", "client")).not.toThrow();
    });

    it("a raw write behind the application (a seed, a fixture) is stopped by the DB trigger", async () => {
      const target = await createUser("raw@w49f-db.test");
      await expect(grantRole(target, editorRole, "company", co)).rejects.toThrow(/client_website_editor may only be granted at scope_type=client/);
      await expect(grantRole(target, staffRole, "client", clientA)).rejects.toThrow(/may only carry the client_website_editor role/);
    });
  });

  // ───────────────────────── assemblePrincipal ─────────────────────────
  describe("assemblePrincipal(): a client-scoped grant lives only while its holder is an active client-wide contact", () => {
    const grantsNamed = (p: Awaited<ReturnType<typeof assemblePrincipal>>) => (p?.roles ?? []).filter((g) => g.role === "client_website_editor");

    it("an ACTIVE client-wide contact: the grant reaches the principal WITH its tenant, and the payload carries it", async () => {
      const u = await createUser("pa1@w49f-db.test");
      await addContact(co, clientA, u);
      await grantRole(u, editorRole, "client", clientA);
      const p = await assemblePrincipal(u, "high");
      expect(grantsNamed(p)).toEqual([{ role: "client_website_editor", scopeType: "client", scopeId: clientA, scopeTenantId: co }]);
      expect(principalPayload(p!).attr.grants).toContainEqual({ role: "client_website_editor", scopeType: "client", scopeId: clientA, scopeTenantId: co });
      // the role confers no permission through the perms arm
      expect(p!.perms!.filter((x) => x.scopeType === "client")).toEqual([]);
    });

    it("a revoked contact, a still-invited one, a deleted row and a project-scoped row: the grant is INERT", async () => {
      for (const [email, opts] of [
        ["pa-revoked", { status: "revoked" }],
        ["pa-invited", { status: "invited" }],
        ["pa-deleted", { deleted: true }],
        ["pa-scoped", { projectId: "__proj__" }],
      ] as const) {
        const u = await createUser(`${email}@w49f-db.test`);
        let projectId: string | null = null;
        if ((opts as { projectId?: string }).projectId) {
          projectId = await createProject(co, "w49f scoped 2", undefined, clientA);
        }
        await addContact(co, clientA, u, { ...(opts as object), projectId });
        await grantRole(u, editorRole, "client", clientA);
        expect(grantsNamed(await assemblePrincipal(u, "high")), email).toEqual([]);
      }
    });

    it("a grant for a client the holder is NOT a contact of (a raw row) is inert; a contact of A holding a grant for B too keeps only A", async () => {
      const u = await createUser("pa-wrong@w49f-db.test");
      await addContact(co, clientA, u);
      await grantRole(u, editorRole, "client", clientB);
      expect(grantsNamed(await assemblePrincipal(u, "high"))).toEqual([]);
      await grantRole(u, editorRole, "client", clientA);
      expect(grantsNamed(await assemblePrincipal(u, "high"))).toEqual([{ role: "client_website_editor", scopeType: "client", scopeId: clientA, scopeTenantId: co }]);
    });

    it("clientAdminOf: exactly the ACTIVE, client-wide, admin rows", async () => {
      const mk = async (email: string, opts: Parameters<typeof addContact>[3]) => {
        const u = await createUser(`${email}@w49f-db.test`);
        await addContact(co, clientA, u, opts);
        return u;
      };
      const adm = await mk("ca-admin", { capability: "admin" });
      expect((await assemblePrincipal(adm, "high"))!.clientAdminOf).toEqual([{ tenantId: co, clientId: clientA }]);
      expect(principalPayload((await assemblePrincipal(adm, "high"))!).attr.clientAdminOf).toEqual([{ tenantId: co, clientId: clientA }]);
      for (const [email, opts] of [
        ["ca-viewer", { capability: "viewer" }], ["ca-signer", { capability: "signer" }],
        ["ca-revoked", { capability: "admin", status: "revoked" }], ["ca-invited", { capability: "admin", status: "invited" }],
        ["ca-deleted", { capability: "admin", deleted: true }],
      ] as const) {
        const u = await mk(email, opts);
        expect((await assemblePrincipal(u, "high"))!.clientAdminOf, email).toEqual([]);
      }
      // staff (no contact rows at all)
      expect((await assemblePrincipal(actor, "high"))!.clientAdminOf).toEqual([]);
    });
  });
});
