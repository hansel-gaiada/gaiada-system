// M5-W1d — the freelance contributor routes over HTTP (buildApp + app.inject, real Postgres + RLS + Cerbos), with the
// Keycloak test double the client-invite suite uses (a hoisted hook per admin call; no hook = the real, unconfigured
// client, which fails closed). The W1d acceptance list, each beside a control:
//   * invite -> `users.kind = contributor`, an anchor, the token shown ONCE (only its sha256 is stored; the list never
//     carries it); a member is 403 with a valid body; a body past 180 days is 400 after authorization;
//   * accept (Keycloak double) -> the account is created in group `contributors` with OTP as a required action, the anchor
//     goes active; the same token again is 400;
//   * the sibling boundary: a CLIENT token is refused by the contributor accept and a CONTRIBUTOR token by the client
//     accept; a client invite never adopts a contributor and a contributor invite never adopts a client or staff row;
//   * ending revokes the grants, bumps the session, disables the login and expires the anchor; the principal then reaches
//     nothing; a re-invite renews the engagement.
// Needs DATABASE_URL_TEST and Cerbos. NOT RUN LOCALLY (owner order: no docker on the laptop); it runs on GitHub Actions.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createHash } from "node:crypto";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { addMembership, createClient, createCompany, createRole, createUser, grantRole } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import { grantEditorialRole } from "../../admin/grant-write.service";
import { createInvite } from "../../core/client-invites";

const kc = vi.hoisted(() => ({
  created: [] as Array<{ email: string; password?: string | null; groups?: string[]; requiredActions?: string[] }>,
  disabled: [] as string[],
  enabled: [] as string[],
  grouped: [] as Array<{ id: string; group: string }>,
  actions: [] as Array<{ id: string; action: string }>,
  existing: new Map<string, string>(), // email -> keycloak id
}));
vi.mock("../../core/keycloak-admin", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../core/keycloak-admin")>();
  return {
    ...orig,
    createUser: async (input: { email: string; password?: string | null; groups?: string[]; requiredActions?: string[] }) => {
      if (kc.existing.has(input.email)) throw new orig.KeycloakUserExistsError(input.email);
      kc.created.push(input);
      const id = `kc-${kc.created.length}`;
      kc.existing.set(input.email, id);
      return id;
    },
    findUserByEmail: async (email: string) => {
      const id = kc.existing.get(email);
      return id ? { id, username: email, email, emailVerified: true, enabled: true } : null;
    },
    disableUser: async (id: string) => { kc.disabled.push(id); },
    enableUser: async (id: string) => { kc.enabled.push(id); },
    logoutUser: async () => {},
    addUserToGroup: async (id: string, group: string) => { kc.grouped.push({ id, group }); },
    addRequiredAction: async (id: string, action: string) => { kc.actions.push({ id, action }); },
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SITE = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2910";
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

describe.skipIf(!TEST_URL)("M5-W1d: freelance contributor routes", () => {
  let app: NestFastifyApplication;
  let A: string;
  let admin: string;
  let member: string;
  const base = () => `/api/${A}/modules/webdev/editorial/contributors`;
  const invite = (by: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${base()}/invite`, headers: asUser(by), payload });
  const accept = (token: string, password = "a-long-enough-password") =>
    app.inject({ method: "POST", url: "/api/editorial-invites/accept", payload: { token, password } });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 9).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1d Contributors Co", ["webdev"]);
    admin = await createUser("admin@w1d-contrib.test");
    member = await createUser("member@w1d-contrib.test");
    await addMembership(A, admin);
    await addMembership(A, member);
    await grantRole(admin, await createRole("company_admin"), "company", A);
    await grantRole(member, await createRole("member"), "company", A);
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("a member is 403 with a VALID body, and nothing is written (the publisher tier invites)", async () => {
    const r = await invite(member, { email: "nope@w1d-contrib.test", validUntil: inDays(30) });
    expect(r.statusCode).toBe(403);
    const u = await adminPool().query(`SELECT 1 FROM users WHERE email = 'nope@w1d-contrib.test'`);
    expect(u.rowCount).toBe(0);
  });

  it("a body past 180 days, or a bad email, is 400 AFTER authorization", async () => {
    expect((await invite(admin, { email: "far@w1d-contrib.test", validUntil: inDays(181) })).statusCode).toBe(400);
    expect((await invite(admin, { email: "not-an-email", validUntil: inDays(30) })).statusCode).toBe(400);
    expect((await invite(admin, { email: "x@w1d-contrib.test", validUntil: inDays(30), role: "webdesk_editor" })).statusCode).toBe(400);
  });

  let token: string;
  let contributorId: string;
  let userId: string;

  it("invite -> kind contributor, an `invited` anchor, the token shown ONCE (only its sha256 stored)", async () => {
    const r = await invite(admin, { email: "Writer@W1d-Contrib.test", name: "Freelance Writer", validUntil: inDays(60) });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.account).toBe("created");
    expect(body.contributor).toMatchObject({ email: "writer@w1d-contrib.test", status: "invited", live: false, sponsorUserId: admin });
    expect(body.invite.delivery).toBe("link");
    expect(body.invite.token).toMatch(/^ctr1\./);
    expect(body.invite.acceptPath).toBe(`/contributor-invite/${body.invite.token}`);
    token = body.invite.token;
    contributorId = body.contributor.contributorId;
    userId = body.contributor.userId;
    const u = await adminPool().query<{ kind: string }>(`SELECT kind FROM users WHERE id = $1`, [userId]);
    expect(u.rows[0].kind).toBe("contributor");
    const inv = await adminPool().query<{ token_hash: string }>(`SELECT token_hash FROM editorial_contributor_invites WHERE contributor_id = $1`, [contributorId]);
    expect(inv.rows.map((x) => x.token_hash)).toEqual([createHash("sha256").update(token, "utf8").digest("hex")]);
    // the raw token is nowhere in the database
    const leak = await adminPool().query(`SELECT 1 FROM editorial_contributor_invites WHERE token_hash = $1 OR email = $1`, [token]);
    expect(leak.rowCount).toBe(0);
    // and never in the list
    const list = await app.inject({ method: "GET", url: base(), headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(token);
    expect(list.json().contributors.map((c: { userId: string }) => c.userId)).toContain(userId);
    // a member cannot list
    expect((await app.inject({ method: "GET", url: base(), headers: asUser(member) })).statusCode).toBe(403);
  });

  it("a second invite while the first is open re-issues: the OLD link stops working, the new one is the only live one", async () => {
    const r = await invite(admin, { email: "writer@w1d-contrib.test", validUntil: inDays(60) });
    expect(r.statusCode).toBe(201);
    expect(r.json().account).toBe("existing");
    const stale = token;
    token = r.json().invite.token;
    expect(token).not.toBe(stale);
    expect((await accept(stale)).statusCode).toBe(400);
  });

  it("a CONTRIBUTOR token is refused by the CLIENT accept, and a CLIENT token by the contributor accept (siblings, never widenings)", async () => {
    const asClient = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { token, password: "a-long-enough-password" } });
    expect(asClient.statusCode).toBe(400);
    // a real client invite token, minted for a real contact row
    const client = await createClient(A, "W1d Client");
    const cu = await createUser("contact@w1d-contrib.test");
    const ccId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, 'viewer', 'invited', $5)`,
        [ccId, A, client, cu, config.originSite],
      ),
    );
    const clientInvite = await createInvite({ tenantId: A, clientContactId: ccId, email: "contact@w1d-contrib.test", invitedBy: admin });
    const r = await accept(clientInvite.token);
    expect(r.statusCode).toBe(400);
    expect(kc.created.map((x) => x.email)).not.toContain("contact@w1d-contrib.test");
    // the contributor token is still unspent after both refusals
    const open = await adminPool().query(`SELECT 1 FROM editorial_contributor_invites WHERE contributor_id = $1 AND consumed_at IS NULL`, [contributorId]);
    expect(open.rowCount).toBe(1);
  });

  it("accept -> Keycloak account in group `contributors` with OTP required; the anchor goes active; a replay is 400", async () => {
    const r = await accept(token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, status: "active", accountPath: "created", secondFactor: "otp_required", existingAccount: false });
    const made = kc.created.find((x) => x.email === "writer@w1d-contrib.test");
    expect(made?.groups).toEqual(["contributors"]);
    expect(made?.requiredActions).toEqual(["CONFIGURE_TOTP"]);
    const a = await adminPool().query<{ status: string; activated_at: Date | null }>(`SELECT status, activated_at FROM editorial_contributors WHERE id = $1`, [contributorId]);
    expect(a.rows[0].status).toBe("active");
    expect(a.rows[0].activated_at).not.toBeNull();
    expect((await accept(token)).statusCode).toBe(400);
    const p = (await assemblePrincipal(userId, "high"))!;
    expect(p.kind).toBe("contributor");
    expect(p.companies).toEqual([A]);
  });

  it("a CLIENT invite never adopts a contributor: 409 contributor_cannot_be_client_contact and no contact row", async () => {
    const client = await createClient(A, "W1d Client Two");
    const r = await app.inject({
      method: "POST", url: `/api/${A}/clients/${client}/contacts`, headers: asUser(admin), payload: { email: "writer@w1d-contrib.test" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe("contributor_cannot_be_client_contact");
    const cc = await adminPool().query(`SELECT 1 FROM client_contacts WHERE user_id = $1`, [userId]);
    expect(cc.rowCount).toBe(0);
    // control: the same route invites an ordinary address
    const ok = await app.inject({
      method: "POST", url: `/api/${A}/clients/${client}/contacts`, headers: asUser(admin), payload: { email: "someone@w1d-client.test" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("a CONTRIBUTOR invite never adopts a client contact or a staff member (409), and converts a clean row", async () => {
    // a client contact's address (the row created by the control above)
    const asClient = await invite(admin, { email: "someone@w1d-client.test", validUntil: inDays(30) });
    expect(asClient.statusCode).toBe(409);
    expect(asClient.json().reason).toBe("contributor_conversion_refused");
    const k1 = await adminPool().query<{ kind: string }>(`SELECT kind FROM users WHERE email = 'someone@w1d-client.test'`);
    expect(k1.rows[0].kind).toBe("employee"); // unchanged
    // a staff member's address
    const asStaff = await invite(admin, { email: "member@w1d-contrib.test", validUntil: inDays(30) });
    expect(asStaff.statusCode).toBe(409);
    expect(asStaff.json().reason).toBe("contributor_conversion_refused");
    // an automation account
    const bot = await createUser("bot@w1d-contrib.test");
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [bot]);
    expect((await invite(admin, { email: "bot@w1d-contrib.test", validUntil: inDays(30) })).statusCode).toBe(409);
    // control: a clean employee-kind row (no grant, membership or contact) converts
    const clean = await createUser("clean@w1d-contrib.test");
    const conv = await invite(admin, { email: "clean@w1d-contrib.test", validUntil: inDays(30) });
    expect(conv.statusCode).toBe(201);
    expect(conv.json().account).toBe("converted");
    const k2 = await adminPool().query<{ kind: string }>(`SELECT kind FROM users WHERE id = $1`, [clean]);
    expect(k2.rows[0].kind).toBe("contributor");
    // self-invite is refused
    expect((await invite(admin, { email: "admin@w1d-contrib.test", validUntil: inDays(30) })).statusCode).toBe(400);
  });

  it("ending revokes the grants, bumps the session, disables the login and expires the anchor; the principal reaches nothing", async () => {
    await withTenants([A], (c) =>
      grantEditorialRole(c, {
        tenantId: A, tenantSlug: "w1d-site", siteId: SITE, targetUserId: userId, role: "webdesk_writer",
        scope: { allCollections: true, allLocales: true }, expiresAt: inDays(20), actorUserId: admin,
      }, { tenantSlug: "w1d-site", siteId: SITE, collectionKeys: ["post"], locales: ["en"] }),
    );
    const before = await adminPool().query<{ v: number }>(`SELECT session_version AS v FROM users WHERE id = $1`, [userId]);
    expect((await assemblePrincipal(userId, "high"))!.roles.map((g) => g.role)).toEqual(["webdesk_writer"]); // control
    // a member cannot end
    expect((await app.inject({ method: "POST", url: `${base()}/${userId}/end`, headers: asUser(member) })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `${base()}/${userId}/end`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ status: "ended", changed: true, sessionBumped: true, idpDisabled: true, idpError: null });
    expect(body.revokedGrantIds).toHaveLength(1);
    expect(kc.disabled).toContain(kc.existing.get("writer@w1d-contrib.test"));
    const after = await adminPool().query<{ v: number }>(`SELECT session_version AS v FROM users WHERE id = $1`, [userId]);
    expect(after.rows[0].v).toBeGreaterThan(before.rows[0].v);
    const grants = await adminPool().query(`SELECT 1 FROM user_roles WHERE user_id = $1`, [userId]);
    expect(grants.rowCount).toBe(0);
    const a = await adminPool().query<{ status: string; expired: boolean }>(
      `SELECT status, valid_until <= now() AS expired FROM editorial_contributors WHERE id = $1`, [contributorId],
    );
    expect(a.rows[0]).toEqual({ status: "ended", expired: true });
    const p = (await assemblePrincipal(userId, "high"))!;
    expect(p.companies).toEqual([]);
    expect(p.roles).toEqual([]);
    // ending again is idempotent
    const again = await app.inject({ method: "POST", url: `${base()}/${userId}/end`, headers: asUser(admin) });
    expect(again.statusCode).toBe(200);
    expect(again.json().changed).toBe(false);
  });

  it("a re-invite renews an ended engagement; accepting it re-enables the EXISTING login without touching its password", async () => {
    const r = await invite(admin, { email: "writer@w1d-contrib.test", validUntil: inDays(30) });
    expect(r.statusCode).toBe(201);
    expect(r.json().contributor.status).toBe("invited");
    const before = kc.created.length;
    const acc = await accept(r.json().invite.token, "a-different-password");
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ accountPath: "existing_reenabled", existingAccount: true });
    expect(kc.created.length).toBe(before); // no second account, no password set
    const id = kc.existing.get("writer@w1d-contrib.test")!;
    expect(kc.enabled).toContain(id);
    expect(kc.grouped).toContainEqual({ id, group: "contributors" });
    expect(kc.actions).toContainEqual({ id, action: "CONFIGURE_TOTP" });
  });
});
