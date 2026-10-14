// W0-4 — HTTP-level tests for ClientContactsController + the public accept route, against live
// PG + RLS + Cerbos. Mirrors meetings.test.ts's shape (buildApp() + app.inject).
//
// Keycloak is NOT configured in this test env (config.keycloakAdmin is all-empty), so anything that
// calls the Keycloak admin client throws KeycloakNotConfiguredError. Two consequences this file
// verifies rather than assumes:
//   - POST /invites/:token/accept must fail WITHOUT half-activating: client_contacts.status must
//     stay 'invited', never flip to 'active', when the IdP call never happens.
//   - POST .../revoke must still succeed locally (status -> 'revoked', invites consumed) even though
//     the best-effort IdP-disable step inside it also throws; the local state is authoritative and
//     the failure is reported back in `idpError`, never swallowed into a false "ok".
//
// NOTE (historical): keycloak-admin.ts's header comment claimed a filter that did not exist, so the
// family fell through to a generic 500. Now fixed — see ClientAccessErrorFilter. Original note:
// "KeycloakAdminErrorFilter maps the family" to a clean 503. That filter did not exist anywhere in
// this repo (grepped; not registered in main.ts), and KeycloakNotConfiguredError extends plain Error,
// not HttpException, so HttpErrorFilter (@Catch(HttpException)) never sees it either. It therefore
// falls through to the unconditional LastResortExceptionFilter, which always answers 500
// { error: "internal error", code: "internal_error" } regardless of the thrown error's own `.status`.
// The assertion below pins the REAL status (500), not the one the comment describes — see the report.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId } from "../db";
import { KeycloakUserExistsError } from "./keycloak-admin";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

// The revoke/accept tests below need to SEE which Keycloak admin calls the handlers make, which an unconfigured
// Keycloak cannot show (it throws before any call). So the Keycloak admin calls are wrapped: with no hook
// installed they run the REAL implementation (every other test in this file keeps its fail-closed,
// KeycloakNotConfiguredError behaviour), and the describes at the bottom install hooks.
const kc = vi.hoisted(() => ({
  find: null as null | ((email: string) => Promise<{ id: string } | null>),
  create: null as null | ((input: { email: string; password?: string | null }) => Promise<string>),
  disable: null as null | ((id: string) => Promise<void>),
  enable: null as null | ((id: string) => Promise<void>),
  setPassword: null as null | ((id: string, password: string) => Promise<void>),
}));
vi.mock("./keycloak-admin", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./keycloak-admin")>();
  return {
    ...orig,
    findUserByEmail: (...a: Parameters<typeof orig.findUserByEmail>) =>
      kc.find ? (kc.find(a[0]) as ReturnType<typeof orig.findUserByEmail>) : orig.findUserByEmail(...a),
    createUser: (...a: Parameters<typeof orig.createUser>) =>
      kc.create ? kc.create(a[0]) : orig.createUser(...a),
    disableUser: (...a: Parameters<typeof orig.disableUser>) =>
      kc.disable ? kc.disable(a[0]) : orig.disableUser(...a),
    enableUser: (...a: Parameters<typeof orig.enableUser>) =>
      kc.enable ? kc.enable(a[0]) : orig.enableUser(...a),
    setPassword: (...a: Parameters<typeof orig.setPassword>) =>
      kc.setPassword ? kc.setPassword(a[0], a[1]) : orig.setPassword(...a),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("client-contacts HTTP surface (W0-4)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let manager: string;
  let member: string;
  let otherAdmin: string;
  let clientId: string;
  let otherClientId: string;
  let projectA: string;
  let projectB: string;
  let otherProjectId: string;
  let siblingClientId: string;
  let siblingProjectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // The invite token HMAC derives from the credential-vault key; without it every invite() call is
    // a 503/ClientInviteError, unrelated to what this file is testing.
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    // Deliberately NOT setting config.keycloakAdmin — the whole point of this suite is the
    // fail-closed behaviour when it is empty, which is the real state of the test env.
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    manager = await createUser("manager@cc.test");
    member = await createUser("member@cc.test");
    otherAdmin = await createUser("admin@rival-cc.test");
    await addMembership(co, manager);
    await addMembership(co, member);
    await addMembership(other, otherAdmin);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", other);

    clientId = await createClient(co, "Bali Beach Resort");
    otherClientId = await createClient(other, "Rival Client");
    // PV4-13: a contact's project must belong to the client the contact is invited to.
    projectA = await createProject(co, "Website Rebuild", undefined, clientId);
    projectB = await createProject(co, "SEO Retainer", undefined, clientId);
    otherProjectId = await createProject(other, "Rival Project");
    // A second client in the SAME tenant, with its own project (the cross-client case below).
    siblingClientId = await createClient(co, "Sibling Client");
    siblingProjectId = await createProject(co, "Sibling Project", undefined, siblingClientId);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ---- create (manager vs member) ----

  it("a manager can invite a client contact -> 201, contact + invite.token, no password/token leak on the contact", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "stakeholder@bali-resort.test", name: "Wayan", capability: "viewer" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.contact).toMatchObject({ clientId, email: "stakeholder@bali-resort.test", status: "invited" });
    expect(body.invite.token).toBeTruthy();
    expect(body.invite.acceptPath).toBe(`/invite/${body.invite.token}`);
    // No password/token/hash field anywhere on the contact view itself.
    const contactKeys = Object.keys(body.contact);
    for (const forbidden of ["password", "token", "tokenHash", "passwordHash", "token_hash"]) {
      expect(contactKeys).not.toContain(forbidden);
    }
  });

  it("a plain member is refused (403) — inviting an external person is manager-tier+", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(member),
      payload: { email: "someone-else@bali-resort.test" },
    });
    expect(r.statusCode).toBe(403);
  });

  // ---- validation ----

  it("rejects an invalid email (400)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "not-an-email" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a bad capability (400)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "cap-test@bali-resort.test", capability: "superadmin" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("a projectId from ANOTHER tenant is refused as not-found (404), not 500, and nothing is created", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "crosstenant-project@bali-resort.test", projectId: otherProjectId },
    });
    expect(r.statusCode).toBe(404);
    const rows = await adminPool().query(`SELECT 1 FROM client_contacts WHERE tenant_id = $1 AND project_id = $2`, [co, otherProjectId]);
    expect(rows.rowCount).toBe(0);
  });

  it("PV4-13: a project of ANOTHER client in the SAME tenant is refused as not-found (404), and nothing is created", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "cross-client-project@bali-resort.test", projectId: siblingProjectId },
    });
    expect(r.statusCode).toBe(404);
    const rows = await adminPool().query(`SELECT 1 FROM client_contacts WHERE tenant_id = $1 AND project_id = $2`, [co, siblingProjectId]);
    expect(rows.rowCount).toBe(0);
    // The same project is accepted for the client it belongs to (the 404 above is about ownership, not the id).
    const ok = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${siblingClientId}/contacts`,
      headers: asUser(manager),
      payload: { email: "own-client-project@bali-resort.test", projectId: siblingProjectId },
    });
    expect(ok.statusCode).toBe(201);
  });

  // ---- re-invite adopts, never duplicates ----

  it("re-inviting the SAME (client, user, client-wide) contact adopts and resets to invited — no second row", async () => {
    const email = "repeat-invite@bali-resort.test";
    const first = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email, capability: "viewer" },
    });
    expect(first.statusCode).toBe(201);
    const firstContactId = first.json().contact.id;

    // Revoke it, then re-invite — the interesting path: adopting a REVOKED row back to 'invited'.
    await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${firstContactId}/revoke`, headers: asUser(manager) });

    const second = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email, capability: "signer" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().contact.id).toBe(firstContactId); // same row, not a new one
    expect(second.json().contact.status).toBe("invited");
    expect(second.json().contact.capability).toBe("signer");
    // A revoked contact keeps today's re-invite: back to invited WITH a fresh token to hand over.
    expect(second.json().invite.token).toBeTruthy();

    // client_contacts itself has no email column (email lives on `users`) — join to filter by it.
    const rows = await adminPool().query(
      `SELECT cc.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.tenant_id = $1 AND cc.client_id = $2 AND u.email = $3 AND cc.project_id IS NULL AND cc.deleted_at IS NULL`,
      [co, clientId, email],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("PV5-F4: re-inviting an ACTIVE contact is refused (409 already_active): still active, capability kept, no new invite", async () => {
    const email = "active-reinvite@bali-resort.test";
    const active = await createUser(email);
    const contactId = newId();
    await adminPool().query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site, activated_at)
       VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', $5, now())`,
      [contactId, co, clientId, active, config.originSite],
    );
    const invites = () => adminPool().query(`SELECT count(*)::int AS n FROM client_invites WHERE client_contact_id = $1`, [contactId]);
    const before = (await invites()).rows[0].n;

    const res = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email, capability: "signer" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ reason: "already_active", existing: { contactId } });
    expect(res.json().invite).toBeUndefined();
    expect(String(res.json().error)).toMatch(/revoke/i);

    const row = (await adminPool().query(`SELECT status, capability, invited_by FROM client_contacts WHERE id = $1`, [contactId])).rows[0];
    expect(row.status).toBe("active");
    expect(row.capability).toBe("viewer"); // not overwritten by the refused request's "signer"
    expect((await invites()).rows[0].n).toBe(before); // no new token minted
    expect((await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'client_contact.invited'`, [contactId])).rowCount).toBe(0);
  });

  it("PV5-F4: re-inviting a still-INVITED contact keeps today's behaviour: 201, the same row, a new token", async () => {
    const email = "invited-reinvite@bali-resort.test";
    const first = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/contacts`, headers: asUser(manager), payload: { email } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/contacts`, headers: asUser(manager), payload: { email, capability: "signer" } });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().contact).toMatchObject({ id: first.json().contact.id, status: "invited", capability: "signer" });
    expect(second.json().invite.token).not.toBe(first.json().invite.token);
  });

  // ---- project-scoped vs client-wide are independent rows for the same person ----

  it("the same person can be a contact on project A AND project B for the same client — 2 rows", async () => {
    const email = "multi-project@bali-resort.test";
    const a = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email, projectId: projectA, capability: "viewer" },
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(manager),
      payload: { email, projectId: projectB, capability: "signer" },
    });
    expect(b.statusCode).toBe(201);
    expect(a.json().contact.id).not.toBe(b.json().contact.id);

    const rows = await adminPool().query(
      `SELECT cc.project_id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.tenant_id = $1 AND cc.client_id = $2 AND u.email = $3 AND cc.deleted_at IS NULL`,
      [co, clientId, email],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.map((row: { project_id: string }) => row.project_id).sort()).toEqual([projectA, projectB].sort());
  });

  // ---- revoke: local state authoritative even when the best-effort IdP disable fails ----

  describe("revoke", () => {
    let contactId: string;

    it("seed: a fresh invited contact", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/clients/${clientId}/contacts`,
        headers: asUser(manager),
        payload: { email: "to-revoke@bali-resort.test" },
      });
      expect(r.statusCode).toBe(201);
      contactId = r.json().contact.id;
    });

    it("revoke flips status to revoked and reports the (failed) IdP attempt in idpError, never throws", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${contactId}/revoke`, headers: asUser(manager) });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe("revoked");
      expect(body.idpDisabled).toBe(false);
      // Keycloak is unconfigured -> the best-effort disable attempt throws internally; local revoke
      // still succeeded (this response returning 200 with status:'revoked' IS that proof), and the
      // failure is surfaced rather than swallowed.
      expect(body.idpError).toBeTruthy();

      const row = await adminPool().query(`SELECT status FROM client_contacts WHERE id = $1`, [contactId]);
      expect(row.rows[0].status).toBe("revoked");
    });

    it("any UNCONSUMED invite for the revoked contact is marked consumed", async () => {
      const row = await adminPool().query(
        `SELECT consumed_at FROM client_invites WHERE client_contact_id = $1`,
        [contactId],
      );
      expect(row.rows[0].consumed_at).not.toBeNull();
    });

    it("a member cannot revoke (403) — revoke is the same governance tier as create", async () => {
      const r2 = await app.inject({
        method: "POST",
        url: `/api/${co}/clients/${clientId}/contacts`,
        headers: asUser(manager),
        payload: { email: "member-cannot-revoke@bali-resort.test" },
      });
      const otherContactId = r2.json().contact.id;
      const r = await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${otherContactId}/revoke`, headers: asUser(member) });
      expect(r.statusCode).toBe(403);
    });

    // ---- accept: reachable with a REAL token, and fails closed ----

    // This block originally pinned TWO real bugs it found. Both are now fixed, so it asserts the fixed
    // behaviour instead — keeping the discovery in the comment because the failure modes were invisible:
    //
    //  1. ROUTING. A real token is ~146 chars and find-my-way's `maxParamLength` defaults to 100, so
    //     `POST /api/invites/:token/accept` 404'd at the raw router for EVERY invite ever minted — the
    //     magic-link flow was dead on arrival and the symptom looked nothing like the cause. Fixed by
    //     moving the token into the request BODY (`POST /api/invites/accept`), which also keeps a
    //     bearer-equivalent secret out of access logs, proxy logs, Referer headers and browser history.
    //  2. FILTER. KeycloakNotConfiguredError and ClientInviteError both extend Error, not
    //     HttpException, so they fell through to LastResortExceptionFilter's unconditional
    //     500 { error:"internal error" } — discarding .status/.code/.missing. Fixed by
    //     ClientAccessErrorFilter (core/client-access-error.filter.ts), registered in main.ts.
    it("a real (~146-char) token REACHES the controller now that it travels in the body", async () => {
      const invite = await app.inject({
        method: "POST",
        url: `/api/${co}/clients/${clientId}/contacts`,
        headers: asUser(manager),
        payload: { email: "accept-fail-closed@bali-resort.test" },
      });
      expect(invite.statusCode).toBe(201);
      const freshContactId = invite.json().contact.id;
      const freshToken = invite.json().invite.token;
      // The precondition for the old routing bug, measured not assumed — this is exactly why the token
      // must not be a path parameter.
      expect(freshToken.length).toBeGreaterThan(100);

      const accept = await app.inject({
        method: "POST",
        url: `/api/invites/accept`,
        payload: { token: freshToken, password: "a-long-enough-password-123" },
      });
      // Keycloak is NOT configured in tests, so this must fail — but as a TYPED 503 naming the missing
      // env vars, which is the whole point of the filter. A 404 here would mean the route is unreachable
      // again; a 500 would mean the filter is not registered.
      expect(accept.statusCode).toBe(503);
      expect(accept.json()).toMatchObject({ code: "keycloak_admin_not_configured" });
      expect(accept.json().missing).toEqual(
        expect.arrayContaining(["KEYCLOAK_ADMIN_BASE_URL", "KEYCLOAK_ADMIN_CLIENT_ID"]),
      );

      // FAILS CLOSED: no half-activation. The contact must still be `invited`, never `active`.
      const row = await adminPool().query(`SELECT status, activated_at FROM client_contacts WHERE id = $1`, [freshContactId]);
      expect(row.rows[0].status).toBe("invited");
      expect(row.rows[0].activated_at).toBeNull();
    });

    it("a malformed token is a coarse typed 400, not a 500 and not an oracle", async () => {
      const accept = await app.inject({ method: "POST", url: `/api/invites/accept`, payload: { token: "short.bad.token" } });
      expect(accept.statusCode).toBe(400);
      expect(accept.json()).toMatchObject({ code: "client_invite_invalid" });
      // Coarse on purpose: unknown / expired / already-used must be indistinguishable on an
      // unauthenticated route (client-invites.test.ts holds the no-oracle property directly).
      expect(accept.json().error).not.toMatch(/expired|consumed|unknown|signature/i);
    });

    it("a missing token is a 400 before any token work", async () => {
      const accept = await app.inject({ method: "POST", url: `/api/invites/accept`, payload: {} });
      expect(accept.statusCode).toBe(400);
    });
  });

  // ---- tenant isolation ----

  it("a rival-tenant admin cannot read or write this tenant's contacts (403/404)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/contacts`, headers: asUser(otherAdmin) });
    // authorize() checks the resource's tenantId against the CALLER's own principal.companies via
    // Cerbos's inTenant, independent of RLS — a rival company_admin is denied at the policy layer
    // before any query runs, so this is 403, not an RLS-emptied 200.
    expect(list.statusCode).toBe(403);

    const invite = await app.inject({
      method: "POST",
      url: `/api/${co}/clients/${clientId}/contacts`,
      headers: asUser(otherAdmin),
      payload: { email: "rival-cannot-invite@bali-resort.test" },
    });
    expect(invite.statusCode).toBe(403);

    // From their OWN tenant's URL they get a real 200 but see nothing of ours (RLS).
    const ownList = await app.inject({ method: "GET", url: `/api/${other}/clients/${otherClientId}/contacts`, headers: asUser(otherAdmin) });
    expect(ownList.statusCode).toBe(200);
    expect(ownList.json()).toHaveLength(0);
  });

  // Kept LAST on purpose: it seeds a (revoked) contact in the rival company, and the tenant-isolation test
  // above asserts that company lists zero contacts.
  // ---- revoke: the IdP account is disabled only when this was the person's LAST active contact ANYWHERE ----
  //
  // Regression for the live bug of 2026-10-13. The "still a contact elsewhere?" read ran on a bare
  // `withGlobal` connection; `client_contacts` is FORCE RLS and that connection set neither the tenant GUC nor
  // `app.principal_user_id`, so the read saw ZERO rows and every revoke disabled the Keycloak account, even for
  // a person with an active contact on another client (the owner's own account is one). The two contacts are
  // deliberately in two DIFFERENT companies: only the cross-tenant `principal_lookup` read can see the other
  // one from inside the first company's request.
  describe("revoke disables the IdP account only for the person's last active contact", () => {
    let otherManager: string;
    let person: string;
    let contactInCo: string;
    let contactInOther: string;
    const disableCalls: string[] = [];

    beforeAll(async () => {
      kc.find = async () => ({ id: "kc-multi-contact-user" });
      kc.disable = async (id: string) => { disableCalls.push(id); };

      otherManager = await createUser("manager@rival-cc.test");
      await addMembership(other, otherManager);
      await grantRole(otherManager, await createRole("manager"), "company", other);

      person = await createUser("two-engagements@cc.test");
      contactInCo = newId();
      contactInOther = newId();
      for (const [id, tenant, client] of [
        [contactInCo, co, clientId],
        [contactInOther, other, otherClientId],
      ]) {
        await adminPool().query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site, activated_at)
           VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', $5, now())`,
          [id, tenant, client, person, config.originSite],
        );
      }
    });
    afterAll(() => {
      kc.find = null;
      kc.disable = null;
    });

    it("seed: the person holds two ACTIVE contacts, one in each of two companies", async () => {
      const r = await adminPool().query(
        `SELECT tenant_id FROM client_contacts WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [person],
      );
      expect(r.rows.map((x) => x.tenant_id).sort()).toEqual([co, other].sort());
    });

    it("revoking one of two active contacts keeps the IdP account: disable NOT called, keptAccountForOtherEngagements true", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${contactInCo}/revoke`, headers: asUser(manager) });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe("revoked");
      expect(body.keptAccountForOtherEngagements).toBe(true);
      expect(body.idpDisabled).toBe(false);
      expect(body.idpError).toBeNull();
      expect(disableCalls).toEqual([]);

      const row = await adminPool().query(`SELECT status FROM client_contacts WHERE id = $1`, [contactInCo]);
      expect(row.rows[0].status).toBe("revoked");
    });

    it("revoking the LAST active contact disables the IdP account exactly once: idpDisabled true, kept false", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${other}/client-contacts/${contactInOther}/revoke`, headers: asUser(otherManager) });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe("revoked");
      expect(body.keptAccountForOtherEngagements).toBe(false);
      expect(body.idpDisabled).toBe(true);
      expect(body.idpError).toBeNull();
      expect(disableCalls).toEqual(["kc-multi-contact-user"]);
    });
  });

  // ---- accept: an invite token must never set a credential on an account that already exists ----
  //
  // Account takeover found 2026-10-13. Any manager can invite ANY email as a contact of their own client (and
  // re-invite an ACTIVE contact), and is handed the raw token (no email transport), so accepting it on an
  // EXISTING Keycloak user used to enable that account and set the password from the request body: the manager
  // then signs in as that person. The rule now: a password is NEVER set on an existing account; it is re-enabled
  // only for a portal-only identity (no membership ever, no role beyond the client-contact roles, no other
  // active contact); staff, ex-staff and global-role holders are never touched by an invite.
  describe("accept never sets a password on an existing Keycloak account", () => {
    const calls = {
      enable: [] as string[],
      setPassword: [] as Array<[string, string]>,
      create: [] as Array<[string, string | null | undefined]>,
    };
    const ATTACKER_PASSWORD = "attacker-chosen-password-1";

    // Invite `email` to `clientId` as `manager`, then accept the token with the attacker's password.
    async function inviteAndAccept(email: string) {
      const invite = await app.inject({
        method: "POST",
        url: `/api/${co}/clients/${clientId}/contacts`,
        headers: asUser(manager),
        payload: { email },
      });
      expect(invite.statusCode).toBe(201);
      const contactId = invite.json().contact.id as string;
      const accept = await app.inject({
        method: "POST",
        url: `/api/invites/accept`,
        payload: { token: invite.json().invite.token, password: ATTACKER_PASSWORD },
      });
      return { contactId, accept };
    }
    async function activationPayload(contactId: string) {
      const r = await adminPool().query(
        `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'client_contact.activated'`,
        [contactId],
      );
      return r.rows[0]?.payload as Record<string, unknown> | undefined;
    }
    /** An already-ACTIVE contact row for `userId` (bypasses the invite flow, as a past engagement would be). */
    async function seedContact(userId: string, tenant: string, client: string, status: "active" | "revoked") {
      const id = newId();
      await adminPool().query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site, activated_at)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', $5, $6, now())`,
        [id, tenant, client, userId, status, config.originSite],
      );
      return id;
    }
    /** The assertions every "left alone" case shares. */
    async function expectUntouched(contactId: string, accept: Awaited<ReturnType<typeof inviteAndAccept>>["accept"]) {
      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ ok: true, status: "active", portalPath: "/portal", existingAccount: true });
      expect(calls.enable).toEqual([]);
      expect(calls.setPassword).toEqual([]);
      const row = await adminPool().query(`SELECT status FROM client_contacts WHERE id = $1`, [contactId]);
      expect(row.rows[0].status).toBe("active");
      const payload = await activationPayload(contactId);
      expect(payload?.accountPath).toBe("existing_kept");
      expect(JSON.stringify(payload)).not.toContain(ATTACKER_PASSWORD);
    }

    beforeAll(() => {
      // Every email "already exists" in Keycloak except these: there createUser WOULD succeed, so a handler that
      // wrongly creates an account is caught by `calls.create`.
      const noKeycloakAccount = new Set(["brand-new-contact@cc.test", "staff-unprovisioned@cc.test"]);
      kc.create = async (input) => {
        calls.create.push([input.email, input.password]);
        if (noKeycloakAccount.has(input.email)) return `kc-new-${input.email}`;
        throw new KeycloakUserExistsError(input.email);
      };
      kc.find = async (email) => (noKeycloakAccount.has(email) ? null : { id: `kc-${email}` });
      kc.enable = async (id) => { calls.enable.push(id); };
      kc.setPassword = async (id, password) => { calls.setPassword.push([id, password]); };
    });
    beforeEach(() => {
      calls.enable.length = 0;
      calls.setPassword.length = 0;
      calls.create.length = 0;
    });
    afterAll(() => {
      kc.create = null;
      kc.find = null;
      kc.enable = null;
      kc.setPassword = null;
    });

    it("STAFF (an active membership): Keycloak untouched, contact activated, existingAccount true", async () => {
      // `member@cc.test` is an active member of `co`; a manager of the same company invites that address.
      const { contactId, accept } = await inviteAndAccept("member@cc.test");
      await expectUntouched(contactId, accept);
    });

    it("STAFF with NO Keycloak account yet: none is created, no password set, contact still activated", async () => {
      // The takeover on the CREATE path: createUser would succeed here (verified email, chosen password) and the
      // first login would then link to the staff row with its memberships and roles.
      const staff = await createUser("staff-unprovisioned@cc.test");
      await addMembership(co, staff);
      const { contactId, accept } = await inviteAndAccept("staff-unprovisioned@cc.test");
      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ ok: true, status: "active", portalPath: "/portal", existingAccount: true });
      expect(calls.create).toEqual([]);
      expect(calls.enable).toEqual([]);
      expect(calls.setPassword).toEqual([]);
      const row = await adminPool().query(`SELECT status FROM client_contacts WHERE id = $1`, [contactId]);
      expect(row.rows[0].status).toBe("active");
      const payload = await activationPayload(contactId);
      expect(payload?.accountPath).toBe("staff_not_provisioned");
      expect(JSON.stringify(payload)).not.toContain(ATTACKER_PASSWORD);
    });

    it("EX-STAFF (only a deleted membership): Keycloak untouched, not re-enabled", async () => {
      const ex = await createUser("ex-staff@cc.test");
      await addMembership(co, ex);
      await adminPool().query(
        `UPDATE company_memberships SET status = 'inactive', deleted_at = now() WHERE user_id = $1`,
        [ex],
      );
      // A revoked contact too, so the ONLY thing separating this from a portal-only identity is the membership.
      await seedContact(ex, other, otherClientId, "revoked");
      const { contactId, accept } = await inviteAndAccept("ex-staff@cc.test");
      await expectUntouched(contactId, accept);
    });

    it("a GLOBAL-ROLE holder with no membership: Keycloak untouched, not re-enabled", async () => {
      const admin = await createUser("global-admin@cc.test");
      await grantRole(admin, await createRole("platform_admin"), "global", null);
      const { contactId, accept } = await inviteAndAccept("global-admin@cc.test");
      await expectUntouched(contactId, accept);
    });

    it("a user with another ACTIVE contact in ANOTHER company: Keycloak untouched", async () => {
      const elsewhere = await createUser("contact-elsewhere@cc.test");
      await seedContact(elsewhere, other, otherClientId, "active");
      const { contactId, accept } = await inviteAndAccept("contact-elsewhere@cc.test");
      await expectUntouched(contactId, accept);
    });

    it("a PORTAL-ONLY identity whose earlier contacts are all revoked: re-enabled, but NO password is set", async () => {
      const portal = await createUser("portal-only@cc.test");
      await seedContact(portal, other, otherClientId, "revoked");
      // The `client` role it was granted on its earlier accept must not make it look like staff.
      const clientRole = await adminPool().query(`SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`);
      await grantRole(portal, clientRole.rows[0].id, "company", other);
      const { contactId, accept } = await inviteAndAccept("portal-only@cc.test");
      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ ok: true, status: "active", portalPath: "/portal", existingAccount: true });
      expect(calls.enable).toEqual(["kc-portal-only@cc.test"]);
      expect(calls.setPassword).toEqual([]);
      const payload = await activationPayload(contactId);
      expect(payload?.accountPath).toBe("existing_reenabled");
      expect(JSON.stringify(payload)).not.toContain(ATTACKER_PASSWORD);
    });

    it("a REVOKED contact re-invited and accepting does NOT set a password (an ACTIVE one cannot be re-invited any more, PV5-F4)", async () => {
      const gone = await createUser("reinvited-revoked@cc.test");
      await seedContact(gone, co, clientId, "revoked");
      // The re-invite flips this very row back to 'invited'; accepting it must still never set a credential.
      const { accept } = await inviteAndAccept("reinvited-revoked@cc.test");
      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ ok: true, existingAccount: true });
      expect(calls.setPassword).toEqual([]);
    });

    it("a brand-new email: the account is created with the chosen password, nothing adopted", async () => {
      const { contactId, accept } = await inviteAndAccept("brand-new-contact@cc.test");
      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ ok: true, status: "active", existingAccount: false });
      expect(calls.create).toEqual([["brand-new-contact@cc.test", ATTACKER_PASSWORD]]);
      expect(calls.enable).toEqual([]);
      expect(calls.setPassword).toEqual([]);
      expect((await activationPayload(contactId))?.accountPath).toBe("created");
    });
  });
});
