// M5-W1d — the `contributor` principal against a REAL database (RLS-bound app role) and REAL Cerbos, no HTTP:
//   (1) migration 202610270900 self-verifies: the users.kind CHECK admits every value it admitted before plus
//       `contributor`, and nothing else; the anchor's CHECKs and guard; FORCE RLS on both new tables;
//   (2) the DB guards, for ANY writer: a contributor is never a member or a client contact; holds only the three roles,
//       time-boxed inside a live anchor (and a grant written with no tenant context is refused: fail closed); a users row
//       converts only when clean; a contributor with an open anchor cannot leave the kind;
//   (3) assemblePrincipal(): only ACTIVE, UNEXPIRED anchors give a company; an invited, ended or expired anchor gives
//       nothing and takes its grants with it; perms are always empty;
//   (4) the grant choke point: the contributor rules on grantEditorialRole, and every generic origin refused;
//   (5) Cerbos, the second wall: every contributor DENY refuses even with a writer grant, and even with a mis-granted
//       staff tier, beside a positive control (the same principal as an employee is ALLOWED); a media upload is refused.
// Needs DATABASE_URL_TEST (and CERBOS_URL for (5)). NOT RUN LOCALLY (owner order: no docker on the laptop); it runs on the
// Linux gate (GitHub Actions).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { addMembership, createClient, createCompany, createRole, createUser, grantRole } from "../testing/fixtures";
import { assemblePrincipal, type Principal } from "./principal";
import { check, type Resource } from "./cerbos";
import { CONTRIBUTOR_ROLES } from "./contributor";
import { grantEditorialRole, insertGrantRow, type VerifiedEditorialSite } from "../admin/grant-write.service";

const liveCerbos = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const SITE = "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const POLICIES = join(__dirname, "..", "..", "cerbos", "policies");
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!TEST_URL)("M5-W1d: the contributor principal in the database", () => {
  let A: string;
  let B: string;
  let sponsor: string;
  let writerRole: string;
  let editorRole: string;
  let memberRole: string;
  const site: VerifiedEditorialSite = { tenantSlug: "w1d-site", siteId: SITE, collectionKeys: ["post"], locales: ["en"] };

  /** A clean users row turned into a contributor (the conversion trigger allows it: no grant, membership or contact). */
  const contributor = async (email: string): Promise<string> => {
    const u = await createUser(email);
    await adminPool().query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [u]);
    return u;
  };
  /** An anchor written behind the application (superuser: RLS does not apply, the guard trigger still does). */
  const anchor = async (tenant: string, userId: string, o: { status?: string; validUntil?: string; endedAt?: boolean } = {}) =>
    (await adminPool().query<{ id: string }>(
      `INSERT INTO editorial_contributors (tenant_id, user_id, sponsor_user_id, status, valid_until, ended_at, origin_site)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now() + interval '30 days'), CASE WHEN $6 THEN now() END, $7) RETURNING id`,
      [tenant, userId, sponsor, o.status ?? "active", o.validUntil ?? null, o.endedAt ?? false, config.originSite],
    )).rows[0].id;
  /** A writer grant + scope row for SITE, written as the grant path does (on the tenant's connection, through the guards). */
  const writerGrant = async (tenant: string, userId: string, expiresAt: string) =>
    withTenants([tenant], (c) =>
      grantEditorialRole(c, {
        tenantId: tenant, tenantSlug: site.tenantSlug, siteId: SITE, targetUserId: userId, role: "webdesk_writer",
        scope: { allCollections: false, collections: ["post"], allLocales: false, locales: ["en"] }, expiresAt, actorUserId: sponsor,
      }, site),
    );
  const in20Days = () => new Date(Date.now() + 20 * DAY).toISOString();

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("W1d Serving Co", ["webdev", "assistant"]);
    B = await createCompany("W1d Other Co", ["webdev"]);
    sponsor = await createUser("sponsor@w1d-db.test");
    await addMembership(A, sponsor);
    writerRole = await createRole("webdesk_writer");
    editorRole = await createRole("webdesk_editor");
    memberRole = await createRole("member");
  }, 120_000);
  afterAll(teardownTestDb);

  // ═════════════════════════════ (1) the migration self-verifies ═════════════════════════════
  describe("migration 202610270900", () => {
    it("the users.kind CHECK kept EVERY previous value and gained exactly `contributor`", async () => {
      const { rows } = await adminPool().query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\\mkind\\M'
            AND pg_get_constraintdef(oid) LIKE '%''employee''%' AND pg_get_constraintdef(oid) NOT LIKE '%home_company_id%'`,
      );
      expect(rows).toHaveLength(1);
      const literals = [...rows[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
      // PK-01's four, none lost, plus the one this ticket adds; nothing else.
      expect(literals).toEqual(["automation", "bot", "client", "contributor", "employee"]);
      // and the database really accepts each of them (a CHECK can read right and still be a different constraint)
      for (const kind of literals) {
        const u = await createUser(`kind-${kind}@w1d-db.test`);
        await expect(adminPool().query(`UPDATE users SET kind = $2 WHERE id = $1`, [u, kind])).resolves.toBeTruthy();
      }
      await expect(adminPool().query(`UPDATE users SET kind = 'vendor' WHERE id = $1`, [sponsor])).rejects.toThrow(/check constraint/);
    });

    it("both new tables are FORCE RLS; the anchor carries principal_lookup, the invites the tenant wall only", async () => {
      const t = await adminPool().query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname IN ('editorial_contributors', 'editorial_contributor_invites')
            AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
      );
      expect(t.rows.map((r) => r.relname)).toEqual(["editorial_contributor_invites", "editorial_contributors"]);
      const p = await adminPool().query<{ k: string }>(
        `SELECT tablename || ':' || policyname || ':' || cmd AS k FROM pg_policies
          WHERE tablename IN ('editorial_contributors', 'editorial_contributor_invites') ORDER BY 1`,
      );
      expect(p.rows.map((r) => r.k)).toEqual([
        "editorial_contributor_invites:tenant_isolation:ALL",
        "editorial_contributors:principal_lookup:SELECT",
        "editorial_contributors:tenant_isolation:ALL",
      ]);
    });

    it("a contributor never has a home company", async () => {
      const u = await contributor("home@w1d-db.test");
      await expect(adminPool().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [u, A]))
        .rejects.toThrow(/users_contributor_no_home_company/);
    });

    it("the anchor: only for a contributor row, at most 180 days, never in the past while live", async () => {
      const emp = await createUser("anchor-emp@w1d-db.test");
      await expect(anchor(A, emp)).rejects.toThrow(/contributor_anchor_kind/);
      const u = await contributor("anchor-window@w1d-db.test");
      await expect(anchor(A, u, { validUntil: new Date(Date.now() + 181 * DAY).toISOString() }))
        .rejects.toThrow(/ck_editorial_contributors_window/);
      await expect(anchor(A, u, { validUntil: new Date(Date.now() - DAY).toISOString() }))
        .rejects.toThrow(/valid_until must be in the future/);
      // positive control: 179 days is fine, and an existing anchor's company or person cannot be repointed
      const id = await anchor(A, u, { validUntil: new Date(Date.now() + 179 * DAY).toISOString() });
      await expect(adminPool().query(`UPDATE editorial_contributors SET tenant_id = $2 WHERE id = $1`, [id, B]))
        .rejects.toThrow(/cannot be changed in place/);
    });

    it("RLS: with no tenant context the app role reads ZERO anchors; under principal_lookup it reads only its own", async () => {
      const u = await contributor("rls@w1d-db.test");
      const v = await contributor("rls-other@w1d-db.test");
      await anchor(A, u);
      await anchor(A, v);
      const bare = await withGlobal((c) => c.query(`SELECT 1 FROM editorial_contributors`));
      expect(bare.rowCount).toBe(0);
      const own = await withGlobal(async (c) => {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.principal_user_id', $1, true)", [u]);
        const r = await c.query<{ user_id: string }>(`SELECT user_id FROM editorial_contributors`);
        await c.query("COMMIT");
        return r.rows.map((x) => x.user_id);
      });
      expect(own).toEqual([u]);
      const tenant = await withTenants([A], (c) => c.query(`SELECT 1 FROM editorial_contributors WHERE user_id = ANY($1::uuid[])`, [[u, v]]));
      expect(tenant.rowCount).toBe(2);
    });
  });

  // ═════════════════════════════ (2) the DB guards ═════════════════════════════
  describe("the guards behind the application", () => {
    it("a contributor can never become a company member or a client contact (positive control: an employee can)", async () => {
      const u = await contributor("never-member@w1d-db.test");
      await expect(addMembership(A, u)).rejects.toThrow(/contributor_not_a_member/);
      const client = await createClient(A, "W1d Client");
      const contact = (userId: string) =>
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
             VALUES ($1, $2, $3, $4, 'viewer', 'invited', $5)`,
            [newId(), A, client, userId, config.originSite],
          ),
        );
      await expect(contact(u)).rejects.toThrow(/contributor_not_a_client_contact/);
      const emp = await createUser("can-member@w1d-db.test");
      await expect(addMembership(A, emp)).resolves.toBeUndefined();
      await expect(contact(await createUser("can-contact@w1d-db.test"))).resolves.toBeTruthy();
    });

    it("a contributor holds ONLY the three roles, always time-boxed, inside a live anchor of that company", async () => {
      const u = await contributor("grants@w1d-db.test");
      await anchor(A, u, { validUntil: new Date(Date.now() + 30 * DAY).toISOString() });
      const raw = (roleId: string, tenant: string, expires: string | null) =>
        adminPool().query(
          `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, expires_at) VALUES ($1, $2, $3, 'company', $4, $5)`,
          [newId(), u, roleId, tenant, expires],
        );
      await expect(raw(memberRole, A, in20Days())).rejects.toThrow(/contributor_role_forbidden/);
      await expect(raw(editorRole, A, in20Days())).rejects.toThrow(/contributor_role_forbidden/);
      await expect(raw(writerRole, A, null)).rejects.toThrow(/contributor_grant_expiry_required/);
      await expect(raw(writerRole, A, new Date(Date.now() + 40 * DAY).toISOString())).rejects.toThrow(/contributor_grant_outlives_anchor/);
      await expect(raw(writerRole, B, in20Days())).rejects.toThrow(/contributor_grant_needs_anchor/);
      // fail closed: the app role with NO tenant context cannot see the anchor, so even a valid grant is refused
      await expect(
        withGlobal((c) =>
          c.query(
            `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, expires_at) VALUES ($1, $2, $3, 'company', $4, $5)`,
            [newId(), u, writerRole, A, in20Days()],
          ),
        ),
      ).rejects.toThrow(/contributor_grant_needs_anchor/);
      // positive control: the same grant inside the anchor is accepted
      await expect(raw(writerRole, A, in20Days())).resolves.toBeTruthy();
      // and the global scope is refused (the editorial guard's own rule fires too)
      await expect(grantRole(u, writerRole, "global", null)).rejects.toThrow(/scope_type=company|contributor_role_forbidden/);
    });

    it("a users row converts only when clean, and a contributor with an open anchor cannot leave the kind", async () => {
      const toContributor = (u: string) => adminPool().query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [u]);
      const withGrant = await createUser("conv-grant@w1d-db.test");
      await grantRole(withGrant, memberRole, "company", A);
      await expect(toContributor(withGrant)).rejects.toThrow(/contributor_conversion_refused/);
      const staff = await createUser("conv-staff@w1d-db.test");
      await addMembership(A, staff);
      await adminPool().query(`UPDATE company_memberships SET deleted_at = now() WHERE user_id = $1`, [staff]); // ex-staff counts too
      await expect(toContributor(staff)).rejects.toThrow(/contributor_conversion_refused/);
      const client = await createClient(A, "W1d Conv Client");
      const exClient = await createUser("conv-client@w1d-db.test");
      await withTenants([A], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site, deleted_at)
           VALUES ($1, $2, $3, $4, 'viewer', 'revoked', $5, now())`,
          [newId(), A, client, exClient, config.originSite],
        ),
      );
      await expect(toContributor(exClient)).rejects.toThrow(/contributor_conversion_refused/);
      // the same refusal through the app role (the trigger reads memberships under its own principal_lookup)
      await expect(withGlobal((c) => c.query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [staff])))
        .rejects.toThrow(/contributor_conversion_refused/);
      // positive control: a clean row converts, through the app role too
      const clean = await createUser("conv-clean@w1d-db.test");
      await expect(withGlobal((c) => c.query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [clean]))).resolves.toBeTruthy();
      // leaving: locked while an anchor is open, free once it has ended
      const id = await anchor(A, clean);
      await expect(adminPool().query(`UPDATE users SET kind = 'employee' WHERE id = $1`, [clean])).rejects.toThrow(/contributor_kind_locked/);
      await adminPool().query(`UPDATE editorial_contributors SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
      await expect(adminPool().query(`UPDATE users SET kind = 'employee' WHERE id = $1`, [clean])).resolves.toBeTruthy();
    });
  });

  // ═════════════════════════════ (3) assemblePrincipal ═════════════════════════════
  describe("assemblePrincipal()", () => {
    it("an ACTIVE anchor gives its company (companies + rootCompanies), the writer grant with its scope, and no perms", async () => {
      const u = await contributor("assemble@w1d-db.test");
      await anchor(A, u);
      await writerGrant(A, u, in20Days());
      const p = (await assemblePrincipal(u, "high"))!;
      expect(p.kind).toBe("contributor");
      expect(p.companies).toEqual([A]);
      expect(p.rootCompanies).toEqual([A]);
      expect(p.roles.map((g) => `${g.role}@${g.scopeType}:${g.scopeId}`)).toEqual([`webdesk_writer@company:${A}`]);
      expect(p.roles[0].editorialScopes).toEqual([{ siteId: SITE, allCollections: false, collections: ["post"], allLocales: false, locales: ["en"] }]);
      expect(p.perms).toEqual([]);
      expect(p.clientAdminOf).toEqual([]);
    });

    it("an INVITED or ENDED anchor gives nothing, and takes the grants of that company with it", async () => {
      const invited = await contributor("assemble-invited@w1d-db.test");
      await anchor(A, invited, { status: "invited" });
      await writerGrant(A, invited, in20Days()); // allowed: staff may pre-grant before the person accepts
      const pi = (await assemblePrincipal(invited, "high"))!;
      expect(pi.companies).toEqual([]);
      expect(pi.rootCompanies).toEqual([]);
      expect(pi.roles).toEqual([]);
      const ended = await contributor("assemble-ended@w1d-db.test");
      const id = await anchor(A, ended);
      await writerGrant(A, ended, in20Days());
      expect((await assemblePrincipal(ended, "high"))!.companies).toEqual([A]); // control: live before the end
      await adminPool().query(`UPDATE editorial_contributors SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
      const pe = (await assemblePrincipal(ended, "high"))!;
      expect(pe.companies).toEqual([]);
      expect(pe.roles).toEqual([]);
    });

    it("an EXPIRED anchor reaches nothing, even with an unexpired grant still in user_roles", async () => {
      const u = await contributor("assemble-expired@w1d-db.test");
      await anchor(A, u, { validUntil: new Date(Date.now() + 3000).toISOString() });
      // a grant row that OUTLIVES its anchor (a month): the guard trigger forbids that shape, so it is planted behind every
      // trigger (superuser, session_replication_role = replica) to prove the ASSEMBLY drops it on its own
      const c = await adminPool().connect();
      try {
        await c.query("SET session_replication_role = replica");
        await c.query(
          `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, expires_at) VALUES ($1, $2, $3, 'company', $4, now() + interval '30 days')`,
          [newId(), u, writerRole, A],
        );
      } finally {
        await c.query("RESET session_replication_role");
        c.release();
      }
      expect((await assemblePrincipal(u, "high"))!.roles.map((g) => g.role)).toEqual(["webdesk_writer"]); // control: held now
      expect((await assemblePrincipal(u, "high"))!.companies).toEqual([A]); // control: live now
      await sleep(3500);
      const p = (await assemblePrincipal(u, "high"))!;
      expect(p.companies).toEqual([]);
      expect(p.rootCompanies).toEqual([]);
      expect(p.roles).toEqual([]);
    });

    it("an anchor never roots a non-contributor (the kind is re-checked in the read)", async () => {
      const u = await contributor("assemble-left@w1d-db.test");
      const id = await anchor(A, u);
      await adminPool().query(`UPDATE editorial_contributors SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
      await adminPool().query(`UPDATE users SET kind = 'employee' WHERE id = $1`, [u]);
      // re-open the anchor behind every guard (superuser, triggers off) to prove the READ ignores it for an employee
      const c = await adminPool().connect();
      try {
        await c.query("SET session_replication_role = replica");
        await c.query(`UPDATE editorial_contributors SET status = 'active', ended_at = NULL WHERE id = $1`, [id]);
      } finally {
        await c.query("RESET session_replication_role");
        c.release();
      }
      const p = (await assemblePrincipal(u, "high"))!;
      expect(p.kind).toBe("employee");
      expect(p.companies).toEqual([]);
    });
  });

  // ═════════════════════════════ (4) the grant choke point ═════════════════════════════
  describe("grantEditorialRole / assertGrantAllowed for a contributor", () => {
    it("writer, translator and SEO reviewer only; never the editor role; expiresAt required and inside the engagement", async () => {
      const u = await contributor("chokepoint@w1d-db.test");
      await anchor(A, u, { validUntil: new Date(Date.now() + 30 * DAY).toISOString() });
      const grant = (role: string, expiresAt: string | null, tenant = A) =>
        withTenants([tenant], (c) =>
          grantEditorialRole(c, {
            tenantId: tenant, tenantSlug: site.tenantSlug, siteId: SITE, targetUserId: u, role,
            scope: { allCollections: true, allLocales: true }, expiresAt, actorUserId: sponsor,
          }, site),
        );
      await expect(grant("webdesk_editor", in20Days())).rejects.toThrow(/contributor_role_forbidden/);
      await expect(grant("webdesk_writer", null)).rejects.toThrow(/contributor_grant_expiry_required/);
      await expect(grant("webdesk_writer", new Date(Date.now() + 45 * DAY).toISOString())).rejects.toThrow(/contributor_grant_outlives_anchor/);
      await expect(grant("webdesk_writer", in20Days(), B)).rejects.toThrow(/no live engagement/);
      for (const role of CONTRIBUTOR_ROLES) {
        await expect(grant(role, in20Days())).resolves.toMatchObject({ role, changed: true });
      }
    });

    it("every generic grant origin refuses a contributor target (trusted_internal included), with a positive control", async () => {
      const u = await contributor("generic@w1d-db.test");
      await anchor(A, u);
      for (const origin of ["legacy_admin", "ui", "trusted_internal"] as const) {
        await expect(
          withTenants([A], (c) =>
            insertGrantRow(c, {
              origin, targetUserId: u, roleId: memberRole, scopeType: "company", scopeId: A, actorUserId: sponsor, tenantId: A,
              onConflict: "unique_columns",
            }),
          ),
        ).rejects.toThrow(/contributor_role_forbidden/);
      }
      const emp = await createUser("generic-emp@w1d-db.test");
      await addMembership(A, emp);
      await expect(
        withTenants([A], (c) =>
          insertGrantRow(c, { origin: "trusted_internal", targetUserId: emp, roleId: memberRole, scopeType: "company", scopeId: A, onConflict: "unique_columns" }),
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ═════════════════════════════ (5) Cerbos, the second wall ═════════════════════════════
  describe.skipIf(!liveCerbos)("Cerbos: the contributor DENYs (live check())", () => {
    let writer: Principal;
    const item = (o: Partial<Resource> = {}): Resource => ({
      kind: "webdesk_content_item", tenantId: A, module: "webdev", siteId: SITE, collectionKey: "post", locale: "en",
      ownerId: writer.userId!, reviewState: "draft", ...o,
    } as Resource);
    /** The same principal with a STAFF tier added by hand: the grant path and the DB guard forbid it; Cerbos must too. */
    const withStaffTier = (p: Principal): Principal => ({
      ...p, roles: [...p.roles, { role: "webdev_manager", scopeType: "company", scopeId: A }, { role: "company_admin", scopeType: "company", scopeId: A }],
    });
    const asEmployee = (p: Principal): Principal => ({ ...p, kind: "employee" });
    const allow = async (p: Principal, r: Resource, action: string) => (await check(p, r, action)).allow;

    beforeAll(async () => {
      const u = await contributor("cerbos@w1d-db.test");
      await anchor(A, u);
      await writerGrant(A, u, in20Days());
      writer = (await assemblePrincipal(u, "high"))!;
    });

    it("positive control: the contributor writer may read, create, update and submit its own draft in scope", async () => {
      for (const action of ["read", "create", "update", "submit", "comment"]) {
        expect(await allow(writer, item(), action), action).toBe(true);
      }
      expect(await allow(writer, { kind: "webdesk_media_asset", tenantId: A, module: "webdev", siteId: SITE } as Resource, "read")).toBe(true);
    });

    it("content: approve, assign, request_publish, publish, schedule, unpublish, delete are DENIED, even with a staff tier", async () => {
      const cases: Array<[string, Partial<Resource>]> = [
        ["approve", { reviewState: "in_review", creatorId: newId() }],
        ["assign", {}],
        ["request_publish", {}],
        ["publish", { approvalId: newId(), creatorId: newId(), itemCount: 1 }],
        ["schedule", { approvalId: newId(), creatorId: newId(), itemCount: 1 }],
        ["unpublish", {}],
        ["delete", {}],
      ];
      for (const [action, attrs] of cases) {
        expect(await allow(writer, item(attrs), action), `${action} as the contributor writer`).toBe(false);
        expect(await allow(withStaffTier(writer), item(attrs), action), `${action} as a contributor with a staff tier`).toBe(false);
        // teeth: the SAME principal as an employee is allowed, so the DENY above is the contributor rule, not a missing ALLOW
        expect(await allow(asEmployee(withStaffTier(writer)), item(attrs), action), `${action} control (employee)`).toBe(true);
      }
    });

    it("collection: apply_schema and manage_editorial are DENIED, even with a staff tier (employee control allowed)", async () => {
      const coll = { kind: "webdesk_collection", tenantId: A, module: "webdev", siteId: SITE } as Resource;
      for (const action of ["apply_schema", "manage_editorial"]) {
        expect(await allow(withStaffTier(writer), coll, action), action).toBe(false);
        expect(await allow(asEmployee(withStaffTier(writer)), coll, action), `${action} control`).toBe(true);
      }
    });

    it("media: EVERY write (upload included) is DENIED, even with a staff tier (W1q's quarantine does not exist yet)", async () => {
      const media = { kind: "webdesk_media_asset", tenantId: A, module: "webdev", siteId: SITE } as Resource;
      for (const action of ["upload", "update", "delete"]) {
        expect(await allow(writer, media, action), `${action} as the writer`).toBe(false);
        expect(await allow(withStaffTier(writer), media, action), `${action} with a staff tier`).toBe(false);
        expect(await allow(asEmployee(withStaffTier(writer)), media, action), `${action} control`).toBe(true);
      }
    });

    it("the role-less ALLOWs: assistant thread, assistant memory, agent run and own approvals are DENIED (employee control allowed)", async () => {
      const own = writer.userId!;
      const cases: Array<[Resource, string]> = [
        [{ kind: "assistant_thread", tenantId: A, ownerId: own } as Resource, "create"],
        [{ kind: "assistant_thread", tenantId: A, ownerId: own } as Resource, "message"],
        [{ kind: "assistant_memory", tenantId: A, ownerId: own } as Resource, "list"],
        [{ kind: "agent_run", tenantId: A, ownerId: own, origin: "assistant_handoff" } as Resource, "read"],
        [{ kind: "automation_approval", tenantId: A, creatorId: own } as Resource, "read"],
      ];
      for (const [r, action] of cases) {
        expect(await allow(writer, r, action), `${r.kind}:${action}`).toBe(false);
        expect(await allow(asEmployee(writer), r, action), `${r.kind}:${action} control`).toBe(true);
      }
    });
  });

  // ═════════════════════════════ the policy files name every write action ═════════════════════════════
  describe("the contributor DENY lists cover every non-read action of their kind (static, no Cerbos)", () => {
    const actionsOf = (file: string) => {
      const doc = yaml.load(readFileSync(join(POLICIES, file), "utf8")) as { resourcePolicy: { rules: Array<{ actions: string[]; effect: string; condition?: { match?: { expr?: string } } }> } };
      const rules = doc.resourcePolicy.rules;
      const all = new Set(rules.flatMap((r) => r.actions).filter((a) => a !== "*"));
      const denied = new Set(
        rules.filter((r) => r.effect === "EFFECT_DENY" && /kind == "contributor"/.test(r.condition?.match?.expr ?? "")).flatMap((r) => r.actions),
      );
      return { all, denied };
    };
    it.each([
      ["resource_webdesk_media_asset.yaml", ["read"]],
      ["resource_webdesk_collection.yaml", ["read"]],
    ])("%s: every action except %j is in the contributor DENY", (file, open) => {
      const { all, denied } = actionsOf(file);
      expect(all.size).toBeGreaterThan(1);
      expect([...all].filter((a) => !open.includes(a) && !denied.has(a))).toEqual([]);
    });
    it.each(["resource_assistant_thread.yaml", "resource_assistant_memory.yaml", "resource_agent_run.yaml"])(
      "%s: the contributor DENY names EVERY action of the kind (listed, so the kind stays non-wildcard)",
      (file) => {
        const { all, denied } = actionsOf(file);
        expect(all.size).toBeGreaterThan(0);
        expect([...all].filter((a) => !denied.has(a))).toEqual([]);
        expect(denied.has("*")).toBe(false);
      },
    );
    it("resource_automation_approval.yaml: the contributor DENY covers every action (`*`; the kind already has a wildcard)", () => {
      expect([...actionsOf("resource_automation_approval.yaml").denied]).toEqual(["*"]);
    });
    it("resource_webdesk_content_item.yaml: the staff functions are denied, the review steps a writer takes are not", () => {
      const { denied } = actionsOf("resource_webdesk_content_item.yaml");
      for (const a of ["approve", "assign", "request_publish", "publish", "schedule", "unpublish", "delete"]) expect(denied.has(a), a).toBe(true);
      for (const a of ["read", "create", "update", "submit", "comment", "request_changes", "seo_signoff"]) expect(denied.has(a), a).toBe(false);
    });
    it("the DB guard and the TS list name the same three roles", () => {
      const sql = readFileSync(join(__dirname, "..", "..", "migrations", "202610270900_contributor_principal.sql"), "utf8");
      const m = sql.match(/v_role NOT IN \(([^)]*)\)/);
      expect(m).toBeTruthy();
      const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
      expect(inSql).toEqual([...CONTRIBUTOR_ROLES].sort());
    });
  });
});
