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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

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
    projectA = await createProject(co, "Website Rebuild");
    projectB = await createProject(co, "SEO Retainer");
    otherProjectId = await createProject(other, "Rival Project");

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

    // client_contacts itself has no email column (email lives on `users`) — join to filter by it.
    const rows = await adminPool().query(
      `SELECT cc.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.tenant_id = $1 AND cc.client_id = $2 AND u.email = $3 AND cc.project_id IS NULL AND cc.deleted_at IS NULL`,
      [co, clientId, email],
    );
    expect(rows.rowCount).toBe(1);
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
});
