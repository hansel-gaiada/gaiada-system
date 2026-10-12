// M5-W1b — the writers' room grants against a REAL database (RLS-bound app role), no HTTP:
//   (1) the migration's guards: the scope table's CHECKs, the scope-row guard (right role, company scope, same tenant),
//       `user_roles_editorial_guard` (company scope only, never position/service-managed, never repointed), and the
//       position-role clause;
//   (2) `principal_lookup` + assemblePrincipal(): a principal sees ITS OWN scopes only, across users and tenants; an
//       unset GUC reads zero rows (the trap the transaction exists to avoid); an expired or scope-less grant gets no
//       `editorialScopes`; and, with CERBOS_URL, a scope-less grant probes DENY beside an in-scope ALLOW;
//   (3) the choke point `grantEditorialRole` / `revokeEditorialRole`: role + scope written atomically, idempotent,
//       re-scoped, multi-site, target eligibility, the expiry rule, revoke removes both.
// Needs DATABASE_URL_TEST (and CERBOS_URL for the probe block). NOT RUN LOCALLY (owner order: no docker on the laptop);
// it runs on the Linux gate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, addMembership } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { check, principalPayload } from "../rbac/cerbos";
import {
  assertGrantAllowed, grantEditorialRole, insertGrantRow, revokeEditorialRole, type GrantOrigin, type VerifiedEditorialSite,
} from "./grant-write.service";
import { assertRoleScopeAllowed } from "./admin-identity.controller";

const liveCerbos = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const S1 = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const S2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SB = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";

describe.skipIf(!TEST_URL)("M5-W1b: writers' room grant scopes in the database", () => {
  let A: string;
  let B: string;
  let writerRole: string;
  let editorRole: string;
  let managerRole: string;
  let actor: string;
  const siteA: VerifiedEditorialSite = { tenantSlug: "gaiada", siteId: S1, collectionKeys: ["post", "guide", "service"], locales: ["en", "id"] };
  const siteA2: VerifiedEditorialSite = { tenantSlug: "gaiada", siteId: S2, collectionKeys: ["post"], locales: ["en"] };

  /** The raw scope-row INSERT a seed or a fixture would make (behind the application). */
  const rawScope = (tenant: string, grantId: string, o: { siteId?: string; allC?: boolean; cols?: readonly string[]; allL?: boolean; locs?: readonly string[] } = {}) =>
    withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO user_role_editorial_scopes (id, user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
         VALUES ($1, $2, $3, 'gaiada', $4, $5, $6, $7, $8, $9)`,
        [newId(), grantId, tenant, o.siteId ?? S1, o.allC ?? false, [...(o.cols ?? ["post"])], o.allL ?? true, [...(o.locs ?? [])], config.originSite],
      ),
    );
  const grantIdOf = async (userId: string, roleId: string, tenant: string) =>
    (await adminPool().query<{ id: string }>(
      `SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
      [userId, roleId, tenant],
    )).rows[0]?.id;
  const scopeCount = async (userId: string) =>
    Number((await adminPool().query(
      `SELECT count(*)::int AS n FROM user_role_editorial_scopes s JOIN user_roles ur ON ur.id = s.user_role_id WHERE ur.user_id = $1`,
      [userId],
    )).rows[0].n);
  const editorialGrants = async (userId: string) =>
    ((await assemblePrincipal(userId, "high"))?.roles ?? []).filter((g) => g.role.startsWith("webdesk_"));
  const employee = async (email: string, tenant: string = A) => {
    const u = await createUser(email);
    await addMembership(tenant, u);
    return u;
  };

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("W1b Serving Co", ["webdev"]);
    B = await createCompany("W1b Other Co", ["webdev"]);
    writerRole = await createRole("webdesk_writer"); // seeded by 202610111443; get-or-create returns it
    editorRole = await createRole("webdesk_editor");
    managerRole = await createRole("manager");
    actor = await employee("actor@w1b-db.test");
  }, 120_000);
  afterAll(teardownTestDb);

  // ═════════════════════════════ (1) the migration's guards ═════════════════════════════
  describe("the guards behind the application (any writer, seeds and fixtures included)", () => {
    it("a raw INSERT of a writers' room role at global / org_unit / project scope is rejected by the trigger", async () => {
      const u = await createUser("raw-global@w1b-db.test");
      await expect(grantRole(u, writerRole, "global", null)).rejects.toThrow(/may only be granted at scope_type=company/);
      await expect(grantRole(u, editorRole, "org_unit", "d-web")).rejects.toThrow(/may only be granted at scope_type=company/);
      await expect(grantRole(u, writerRole, "project", newId())).rejects.toThrow(/may only be granted at scope_type=company/);
      // positive control: company scope is accepted (and is inert until it has scope rows)
      await expect(grantRole(u, writerRole, "company", A)).resolves.toBeUndefined();
      expect(await grantIdOf(u, writerRole, A)).toBeTruthy();
    });

    it("an editorial grant cannot be marked position- or service-managed, nor repointed to another role or scope", async () => {
      const u = await createUser("repoint@w1b-db.test");
      await grantRole(u, writerRole, "company", A);
      const id = (await grantIdOf(u, writerRole, A))!;
      await expect(adminPool().query(`UPDATE user_roles SET managed_by_position = $2 WHERE id = $1`, [id, newId()]))
        .rejects.toThrow(/may not be provisioned by a position or a service assignment/);
      await expect(adminPool().query(`UPDATE user_roles SET role_id = $2 WHERE id = $1`, [id, managerRole]))
        .rejects.toThrow(/cannot be changed in place/);
      await expect(adminPool().query(`UPDATE user_roles SET scope_id = $2 WHERE id = $1`, [id, B]))
        .rejects.toThrow(/cannot be changed in place/);
      // positive control: a non-identity column of the same row still updates
      await expect(adminPool().query(`UPDATE user_roles SET expires_at = now() + interval '1 day' WHERE id = $1`, [id])).resolves.toBeTruthy();
    });

    it("a scope row may only hang off a writers' room grant, at company scope, of its own tenant", async () => {
      const u = await createUser("scope-guard@w1b-db.test");
      await grantRole(u, managerRole, "company", A);
      const mgrGrant = (await grantIdOf(u, managerRole, A))!;
      await expect(rawScope(A, mgrGrant)).rejects.toThrow(/may only belong to a writers' room grant/);
      await grantRole(u, writerRole, "company", A);
      const wGrant = (await grantIdOf(u, writerRole, A))!;
      // A's grant, but a row filed under tenant B (written on a B connection so RLS lets it reach the trigger)
      await expect(rawScope(B, wGrant)).rejects.toThrow(/is not the grant's company/);
      // positive control
      await expect(rawScope(A, wGrant)).resolves.toBeTruthy();
      // RLS: a connection of another tenant cannot write a row for tenant A at all
      await expect(
        withTenants([B], (c) =>
          c.query(
            `INSERT INTO user_role_editorial_scopes (id, user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
             VALUES ($1, $2, $3, 'gaiada', $4, true, '{}', true, '{}', $5)`,
            [newId(), wGrant, A, S2, config.originSite],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("the CHECKs: 'all' is a boolean never an empty list; lists are bounded, distinct, trimmed", async () => {
      const u = await createUser("checks@w1b-db.test");
      await grantRole(u, writerRole, "company", A);
      const g = (await grantIdOf(u, writerRole, A))!;
      for (const [label, o] of [
        ["all + a list", { allC: true, cols: ["post"] }],
        ["not all + empty list", { allC: false, cols: [] }],
        ["duplicate keys", { cols: ["post", "post"] }],
        ["a padded key", { cols: [" post"] }],
        ["not all locales + empty", { allL: false, locs: [] }],
        ["a 36-char locale", { allL: false, locs: ["x".repeat(36)] }],
      ] as const) {
        await expect(rawScope(A, g, { siteId: newId(), ...o }), label).rejects.toThrow(/ck_ures_/);
      }
    });

    it("the position-role clause: the four roles can never be attached to a position's role set", async () => {
      const pos = newId();
      await withTenants([A], (c) =>
        c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title, origin_site) VALUES ($1, $2, 'd-web', 'Writer seat', $3)`, [pos, A, config.originSite]),
      );
      for (const roleId of [writerRole, editorRole]) {
        await expect(
          withTenants([A], (c) => c.query(`INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1, $2, $3, 'company')`, [A, pos, roleId])),
        ).rejects.toThrow(/editorial_role_dedicated_path/);
      }
      // positive control: an ordinary role attaches
      await expect(
        withTenants([A], (c) => c.query(`INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1, $2, $3, 'company')`, [A, pos, managerRole])),
      ).resolves.toBeTruthy();
    });

    it("the generic choke-point origins refuse the four by name (editorial_role_dedicated_path); the scope map pins company", async () => {
      const target = await employee("generic@w1b-db.test");
      for (const origin of ["legacy_admin", "ui", "two_person_appointment"] as GrantOrigin[]) {
        await expect(
          withGlobal((c) => insertGrantRow(c, { origin, targetUserId: target, roleId: writerRole, scopeType: "company", scopeId: A, actorUserId: actor, tenantId: A, onConflict: "unique_columns" })),
        ).rejects.toThrow(/editorial_role_dedicated_path/);
        await expect(
          withGlobal((c) => assertGrantAllowed(c, { origin, targetUserId: target, roleId: editorRole, scopeType: "company", scopeId: A, actorUserId: actor, tenantId: A, onConflict: "unique_columns" })),
        ).rejects.toThrow(/editorial_role_dedicated_path/);
      }
      expect(await grantIdOf(target, writerRole, A)).toBeUndefined();
      expect(() => assertRoleScopeAllowed("webdesk_writer", "global")).toThrow(/only be granted at company scope/);
      expect(() => assertRoleScopeAllowed("webdesk_editor", "company")).not.toThrow();
    });
  });

  // ═════════════════════════════ (2) principal_lookup + assemblePrincipal ═════════════════════════════
  describe("assemblePrincipal(): editorialScopes per grant, own rows only, fail closed", () => {
    it("a grant with scope rows arrives WITH them (and the Cerbos payload carries them); a scope-less grant arrives with none", async () => {
      const u = await employee("pa-own@w1b-db.test");
      await grantRole(u, writerRole, "company", A);
      const g = (await grantIdOf(u, writerRole, A))!;
      expect(await editorialGrants(u)).toEqual([{ role: "webdesk_writer", scopeType: "company", scopeId: A }]); // no rows yet: no member
      await rawScope(A, g, { siteId: S1, cols: ["post"], allL: false, locs: ["en"] });
      await rawScope(A, g, { siteId: S2, allC: true, cols: [], allL: true, locs: [] });
      const grants = await editorialGrants(u);
      expect(grants).toHaveLength(1);
      expect([...grants[0].editorialScopes!].sort((x, y) => x.siteId.localeCompare(y.siteId))).toEqual(
        [
          { siteId: S1, allCollections: false, collections: ["post"], allLocales: false, locales: ["en"] },
          { siteId: S2, allCollections: true, collections: [], allLocales: true, locales: [] },
        ].sort((x, y) => x.siteId.localeCompare(y.siteId)),
      );
      const p = (await assemblePrincipal(u, "high"))!;
      expect(principalPayload(p).attr.grants.find((x) => x.role === "webdesk_writer")).toHaveProperty("editorialScopes");
      // the four roles confer nothing through the perms arm
      expect((p.perms ?? []).length).toBe(0);
    });

    it("CROSS-USER and CROSS-TENANT: a principal sees only its OWN scope rows, each attached to its own tenant's grant", async () => {
      const u = await employee("pa-u@w1b-db.test");
      await addMembership(B, u);
      const v = await employee("pa-v@w1b-db.test");
      await grantRole(u, writerRole, "company", A);
      await grantRole(u, writerRole, "company", B);
      await grantRole(v, writerRole, "company", A);
      await rawScope(A, (await grantIdOf(u, writerRole, A))!, { siteId: S1 });
      await rawScope(B, (await grantIdOf(u, writerRole, B))!, { siteId: SB });
      await rawScope(A, (await grantIdOf(v, writerRole, A))!, { siteId: S2 });
      const byTenant = new Map((await editorialGrants(u)).map((g) => [g.scopeId, g.editorialScopes?.map((s) => s.siteId)]));
      expect(byTenant.get(A)).toEqual([S1]);
      expect(byTenant.get(B)).toEqual([SB]);
      expect((await editorialGrants(v))[0].editorialScopes!.map((s) => s.siteId)).toEqual([S2]);
    });

    it("principal_lookup exposes exactly one user's rows; an UNSET GUC reads ZERO rows with no error (the trap)", async () => {
      const u = await employee("pl-u@w1b-db.test");
      const v = await employee("pl-v@w1b-db.test");
      await grantRole(u, editorRole, "company", A);
      await grantRole(v, editorRole, "company", A);
      await rawScope(A, (await grantIdOf(u, editorRole, A))!, { siteId: S1 });
      await rawScope(A, (await grantIdOf(v, editorRole, A))!, { siteId: S1 });
      const asLookup = (userId: string) =>
        withGlobal(async (c) => {
          await c.query("BEGIN");
          try {
            await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
            const r = await c.query<{ user_id: string }>(
              `SELECT ur.user_id FROM user_role_editorial_scopes s JOIN user_roles ur ON ur.id = s.user_role_id`,
            );
            await c.query("COMMIT");
            return r.rows.map((x) => x.user_id);
          } catch (e) {
            await c.query("ROLLBACK");
            throw e;
          }
        });
      expect(new Set(await asLookup(u))).toEqual(new Set([u]));
      expect(new Set(await asLookup(v))).toEqual(new Set([v]));
      // no GUC, no tenant: zero rows, silently. This is why assemblePrincipal reads inside its lookup transaction.
      const bare = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM user_role_editorial_scopes`));
      expect(bare.rows[0].n).toBe(0);
      // the tenant wall shows the tenant's rows (both users) and nothing of another tenant
      const inA = await withTenants([A], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_role_editorial_scopes WHERE tenant_id <> $1`, [A]));
      expect(inA.rows[0].n).toBe(0);
    });

    it("an EXPIRED grant brings no scopes (and is not in roles at all)", async () => {
      const u = await employee("pa-exp@w1b-db.test");
      await grantRole(u, writerRole, "company", A);
      const g = (await grantIdOf(u, writerRole, A))!;
      await rawScope(A, g);
      await adminPool().query(`UPDATE user_roles SET expires_at = now() - interval '1 minute' WHERE id = $1`, [g]);
      expect(await editorialGrants(u)).toEqual([]);
    });

    describe.skipIf(!liveCerbos)("through the real check(): a scope-less grant probes DENY (positive control beside it)", () => {
      const read = (siteId: string, collectionKey = "post") =>
        ({ kind: "webdesk_content_item", tenantId: A, module: "webdev", id: newId(), siteId, collectionKey, locale: "en" }) as const;
      it("scope-less: DENY; after one scope row: ALLOW in scope, DENY out of scope", async () => {
        const u = await employee("probe@w1b-db.test");
        await grantRole(u, writerRole, "company", A);
        const before = (await assemblePrincipal(u, "high"))!;
        expect((await check(before, read(S1), "read")).allow).toBe(false);
        await rawScope(A, (await grantIdOf(u, writerRole, A))!, { siteId: S1, cols: ["post"] });
        const after = (await assemblePrincipal(u, "high"))!;
        expect((await check(after, read(S1), "read")).allow).toBe(true);
        expect((await check(after, read(S1, "guide"), "read")).allow).toBe(false);
        expect((await check(after, read(S2), "read")).allow).toBe(false);
      });
    });
  });

  // ═════════════════════════════ (3) the choke point ═════════════════════════════
  describe("grantEditorialRole / revokeEditorialRole", () => {
    const spec = (targetUserId: string, over: Record<string, unknown> = {}) => ({
      tenantId: A, tenantSlug: "gaiada", siteId: S1, targetUserId, role: "webdesk_writer",
      scope: { collections: ["post"], locales: ["en"] }, expiresAt: null, actorUserId: actor, ...over,
    });

    it("writes the role and its scope together; a failure later in the SAME transaction leaves neither", async () => {
      const u = await employee("atomic@w1b-db.test");
      await expect(
        withTenants([A], async (c) => {
          await grantEditorialRole(c, spec(u), siteA);
          throw new Error("boom after the grant");
        }),
      ).rejects.toThrow(/boom/);
      expect(await grantIdOf(u, writerRole, A)).toBeUndefined();
      expect(await scopeCount(u)).toBe(0);
      const r = await withTenants([A], (c) => grantEditorialRole(c, spec(u), siteA));
      expect(r).toMatchObject({ role: "webdesk_writer", changed: true, createdGrant: true, expiresAt: null });
      expect(await grantIdOf(u, writerRole, A)).toBe(r.grantId);
      expect(await scopeCount(u)).toBe(1);
    });

    it("is idempotent, re-scopes in place, and carries a second site on the SAME grant", async () => {
      const u = await employee("idem@w1b-db.test");
      const first = await withTenants([A], (c) => grantEditorialRole(c, spec(u), siteA));
      const again = await withTenants([A], (c) => grantEditorialRole(c, spec(u, { scope: { collections: ["post"], locales: ["en"] } }), siteA));
      expect(again).toMatchObject({ grantId: first.grantId, changed: false, createdGrant: false });
      const rescoped = await withTenants([A], (c) => grantEditorialRole(c, spec(u, { scope: { collections: ["guide", "post"], allLocales: true } }), siteA));
      expect(rescoped).toMatchObject({ grantId: first.grantId, changed: true, createdGrant: false });
      const second = await withTenants([A], (c) => grantEditorialRole(c, spec(u, { siteId: S2, scope: { allCollections: true, allLocales: true } }), siteA2));
      expect(second).toMatchObject({ grantId: first.grantId, changed: true, createdGrant: false });
      expect(await scopeCount(u)).toBe(2);
      const g = (await editorialGrants(u))[0];
      expect(g.editorialScopes!.find((s) => s.siteId === S1)).toEqual({ siteId: S1, allCollections: false, collections: ["guide", "post"], allLocales: true, locales: [] });
    });

    it("refuses a target who is not an active employee member of THIS company", async () => {
      const stranger = await createUser("stranger@w1b-db.test"); // no membership
      const otherCo = await employee("other-co@w1b-db.test", B);
      const bot = await employee("bot@w1b-db.test");
      await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);
      const client = await employee("client-kind@w1b-db.test");
      await adminPool().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [client]);
      const inactive = await employee("inactive@w1b-db.test");
      await adminPool().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [inactive]).catch(() =>
        adminPool().query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [inactive]),
      );
      for (const t of [stranger, otherCo, bot, client, inactive]) {
        await expect(withTenants([A], (c) => grantEditorialRole(c, spec(t), siteA))).rejects.toThrow(/editorial_target_not_eligible/);
        expect(await scopeCount(t)).toBe(0);
      }
    });

    it("the expiry belongs to the grant: a different expiry for an existing grant is 409; an EXPIRED grant is replaced", async () => {
      const u = await employee("expiry@w1b-db.test");
      const until = new Date(Date.now() + 30 * 86400000).toISOString();
      await withTenants([A], (c) => grantEditorialRole(c, spec(u, { expiresAt: until }), siteA));
      await expect(withTenants([A], (c) => grantEditorialRole(c, spec(u, { siteId: S2, expiresAt: null }), siteA2))).rejects.toThrow(/editorial_grant_expiry_mismatch/);
      await expect(withTenants([A], (c) => grantEditorialRole(c, spec(u, { siteId: S2, expiresAt: until }), siteA2))).resolves.toMatchObject({ changed: true });
      const old = (await grantIdOf(u, writerRole, A))!;
      await adminPool().query(`UPDATE user_roles SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old]);
      const fresh = await withTenants([A], (c) => grantEditorialRole(c, spec(u, { expiresAt: null }), siteA));
      expect(fresh.createdGrant).toBe(true);
      expect(fresh.grantId).not.toBe(old);
      expect(await scopeCount(u)).toBe(1); // the expired grant's two rows went with it
    });

    it("revoke removes this site's row; the LAST site takes the grant too; a second revoke is a no-op", async () => {
      const u = await employee("revoke@w1b-db.test");
      const g = await withTenants([A], (c) => grantEditorialRole(c, spec(u), siteA));
      await withTenants([A], (c) => grantEditorialRole(c, spec(u, { siteId: S2, scope: { allCollections: true, allLocales: true } }), siteA2));
      const rv = (siteId: string) => withTenants([A], (c) => revokeEditorialRole(c, { tenantId: A, siteId, targetUserId: u, role: "webdesk_writer" }));
      expect(await rv(S1)).toEqual({ grantId: g.grantId, removedScope: true, removedGrant: false });
      expect(await grantIdOf(u, writerRole, A)).toBe(g.grantId);
      expect(await rv(S2)).toEqual({ grantId: g.grantId, removedScope: true, removedGrant: true });
      expect(await grantIdOf(u, writerRole, A)).toBeUndefined();
      expect(await scopeCount(u)).toBe(0);
      expect(await rv(S2)).toBeNull();
      // another company's connection cannot revoke A's grant
      await withTenants([A], (c) => grantEditorialRole(c, spec(u), siteA));
      expect(await withTenants([B], (c) => revokeEditorialRole(c, { tenantId: B, siteId: S1, targetUserId: u, role: "webdesk_writer" }))).toBeNull();
      expect(await scopeCount(u)).toBe(1);
    });

    it("a scope-less grant left behind by a raw writer is cleaned up by a revoke", async () => {
      const u = await employee("orphan@w1b-db.test");
      await grantRole(u, editorRole, "company", A);
      const r = await withTenants([A], (c) => revokeEditorialRole(c, { tenantId: A, siteId: S1, targetUserId: u, role: "webdesk_editor" }));
      expect(r).toMatchObject({ removedScope: false, removedGrant: true });
      expect(await grantIdOf(u, editorRole, A)).toBeUndefined();
    });
  });
});
