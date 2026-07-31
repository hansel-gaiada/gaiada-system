// SM-25a — the HTTP surface over google/oauth.ts (design addendum §A12; tracker §6ao "owed"). LIVE
// Postgres (RLS actually exercised), LIVE Cerbos (NOT mocked — unlike search-rank.test.ts/
// search-provider-pulls.test.ts, which stub `check` to always-allow; this file needs the REAL policy
// engine to prove the "missing Cerbos permission" refusal actually denies, and search-cerbos.test.ts
// already proves resource_search_property's parity matrix in isolation, so this file adds real roles
// via createRole/grantRole rather than re-deriving that matrix), and a REAL Google-shaped issuer (the
// SM-51 sandbox, over real sockets) so the whole authorize -> consent -> callback -> exchange -> seal
// chain runs through this module's actual HTTP routes end to end.
//
// ⚠ BINDING (§A12.5, carried from google-oauth.sandbox.test.ts): a green run here is a validated
// client of OUR OWN MODEL of Google, not a validated Google integration. SM-41G owns the rest.
//
// WHAT THIS FILE PROVES, per the ticket's own emphasis ("test the refusals, not the happy path"):
//   1. one happy-path smoke test tying all seven routes together, with an explicit assertion that NO
//      response body anywhere in the chain carries token material or `enc:v1:` ciphertext (the
//      masked-view boundary is asserted here, not trusted from the service layer);
//   2. unknown provider (both the authorize route and the callback);
//   3. missing Cerbos permission (a real principal with no search-module grant, real Cerbos deciding);
//   4. the callback requires authentication at all (401, no headers);
//   5. a forged state (corrupted HMAC) and a state whose TENANT segment is spliced to a different
//      tenant (attack A2 in oauth-state.ts) are both refused before any exchange;
//   6. a completed state cannot be replayed;
//   7. cross-tenant isolation on the connections routes: a connection created in tenant A is
//      invisible from tenant B even for a principal who belongs to both (404, never a leak);
//   8. the two FK/ownership cross-checks this HTTP layer adds on top of the service functions
//      (property-belongs-to-client on /authorize; connection-belongs-to-property's-client on bind).
//   9. Google's own consent-denial callback (`error=access_denied`) is a clean, non-throwing outcome.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createRole, grantRole } from "../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../testing/vendor-sandbox/google-server";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const CLIENT_ID = "sm25a-http-google-dev";
const CLIENT_SECRET = "sm25a-http-google-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";

/** Anything in this list appearing in a response body is a masked-view breach. Deliberately checked
 *  by STRING SCAN of the raw JSON text, not by field-presence on a typed interface — a breach via a
 *  field this test doesn't know to name (e.g. a nested `meta.rawToken`) still trips a string scan. */
const SECRET_MARKERS = ["enc:v1:", "accessToken", "access_token", "refreshToken", "refresh_token", "codeVerifier", "code_verifier"];
function assertNoSecrets(label: string, body: unknown): void {
  const text = JSON.stringify(body);
  for (const marker of SECRET_MARKERS) {
    expect(text, `${label} response leaked "${marker}": ${text}`).not.toContain(marker);
  }
}

describe.skipIf(!TEST_URL)("SM-25a · Google OAuth HTTP surface (search.controller.ts + the callback controller)", () => {
  let app: NestFastifyApplication;
  let sb: GoogleSandbox;
  let tenantA: string;
  let tenantB: string;
  let staffA: string; // search_staff in tenant A only
  let staffBoth: string; // search_staff in BOTH tenants (the cross-tenant-isolation test)
  let plainMemberA: string; // member of tenant A, no search-module role
  let clientA: string;
  let clientA2: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64");

    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    config.search.google.clientId = CLIENT_ID;
    config.search.google.clientSecret = CLIENT_SECRET;
    config.search.google.redirectUri = REDIRECT_URI;
    config.search.google.authorizeUrl = sb.endpoints.authorizeUrl;
    config.search.google.tokenUrl = sb.endpoints.tokenUrl;
    config.search.google.revokeUrl = sb.endpoints.revokeUrl;
    config.search.google.searchConsoleBaseUrl = sb.endpoints.searchConsoleBaseUrl;
    config.search.google.analyticsDataBaseUrl = sb.endpoints.analyticsDataBaseUrl;
    config.search.google.adsBaseUrl = sb.endpoints.adsBaseUrl;

    tenantA = await createCompany("SM-25a HTTP Agency A", ["search"]);
    tenantB = await createCompany("SM-25a HTTP Agency B", ["search"]);
    staffA = await createUser("staffa@sm25a-http.test");
    staffBoth = await createUser("staffboth@sm25a-http.test");
    plainMemberA = await createUser("plain@sm25a-http.test");
    await addMembership(tenantA, staffA);
    await addMembership(tenantA, staffBoth);
    await addMembership(tenantB, staffBoth);
    await addMembership(tenantA, plainMemberA);

    const searchStaffRole = await createRole("search_staff");
    const memberRole = await createRole("member");
    await grantRole(staffA, searchStaffRole, "company", tenantA);
    await grantRole(staffBoth, searchStaffRole, "company", tenantA);
    await grantRole(staffBoth, searchStaffRole, "company", tenantB);
    await grantRole(plainMemberA, memberRole, "company", tenantA); // generic role, NOT module-scoped

    clientA = await createClient(tenantA, "SM-25a HTTP Client A");
    clientA2 = await createClient(tenantA, "SM-25a HTTP Client A2");

    app = await buildApp();
  });

  afterAll(async () => {
    if (sb) await sb.close();
    if (app) await app.close();
    await teardownTestDb();
  });

  /** Walk the issuer's authorize redirect the way a browser would — the one step a server cannot
   *  perform for the user (same helper google-oauth.sandbox.test.ts uses at the service layer; here
   *  it walks the URL the HTTP /authorize route actually returned). */
  async function walkConsent(authorizeUrl: string): Promise<{ code: string; state: string }> {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBeNull();
    return { code: loc.searchParams.get("code")!, state: loc.searchParams.get("state")! };
  }

  async function startAndWalk(opts: { tenantId: string; userId: string; clientId: string; propertyId?: string }) {
    const started = await app.inject({
      method: "POST",
      url: `/api/${opts.tenantId}/modules/search/google/connections/google_search_console/authorize`,
      headers: asUser(opts.userId),
      payload: { clientId: opts.clientId, propertyId: opts.propertyId },
    });
    expect(started.statusCode).toBe(200);
    assertNoSecrets("authorize", started.json());
    const { code, state } = await walkConsent(started.json().authorizeUrl as string);
    return { started, code, state };
  }

  function callback(userId: string, params: { code?: string; state?: string; provider?: string; error?: string }) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return app.inject({ method: "GET", url: `/api/search/google/oauth/callback?${qs}`, headers: asUser(userId) });
  }

  // ── 1 · happy path, every route, no secrets anywhere ──────────────────────────────────────────────
  it("authorize -> callback -> list/get/refresh/revoke/bind all wire through, and no response ever carries token material", async () => {
    const { code, state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });

    const done = await callback(staffA, { code, state, provider: "google_search_console" });
    expect(done.statusCode).toBe(200);
    const connection = done.json() as { id: string; provider: string; hasToken: boolean; issuerHost: string; issuerIsGoogle: boolean };
    assertNoSecrets("callback", connection);
    expect(connection.provider).toBe("google_search_console");
    expect(connection.hasToken).toBe(true);
    // §A12.3's honesty rule: the sandbox is not Google's own host, so issuerIsGoogle must be false
    // and issuerHost must be present for a UI to render it.
    expect(connection.issuerIsGoogle).toBe(false);
    expect(connection.issuerHost).toBeTruthy();

    const list = await app.inject({
      method: "GET", url: `/api/${tenantA}/modules/search/google/connections?clientId=${clientA}`, headers: asUser(staffA),
    });
    expect(list.statusCode).toBe(200);
    assertNoSecrets("list", list.json());
    expect((list.json() as Array<{ id: string }>).some((c) => c.id === connection.id)).toBe(true);

    const get = await app.inject({
      method: "GET", url: `/api/${tenantA}/modules/search/google/connections/${connection.id}`, headers: asUser(staffA),
    });
    expect(get.statusCode).toBe(200);
    assertNoSecrets("get", get.json());

    const refresh = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/${connection.id}/refresh`, headers: asUser(staffA),
    });
    expect(refresh.statusCode).toBe(200);
    assertNoSecrets("refresh", refresh.json());

    // Bind, via a fresh property this connection's client owns.
    const propRes = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/properties`, headers: asUser(staffA),
      payload: { clientId: clientA, domain: `sm25a-http-${Date.now()}.example.com`, siteUrl: "https://sm25a-http.example.com" },
    });
    expect(propRes.statusCode).toBe(201);
    const propertyId = propRes.json().id as string;
    const bind = await app.inject({
      method: "PUT", url: `/api/${tenantA}/modules/search/properties/${propertyId}/google-connection/google_search_console`,
      headers: asUser(staffA), payload: { connectionId: connection.id },
    });
    expect(bind.statusCode).toBe(200);
    assertNoSecrets("bind", bind.json());

    const revoke = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/${connection.id}/revoke`, headers: asUser(staffA),
    });
    expect(revoke.statusCode).toBe(200);
    assertNoSecrets("revoke", revoke.json());
    expect((revoke.json() as { connection: { status: string } }).connection.status).toBe("revoked");
  });

  // ── 2 · unknown provider ──────────────────────────────────────────────────────────────────────────
  it("an unknown provider is rejected with 400 on BOTH the authorize route and the callback", async () => {
    const authorizeBad = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/google_bogus/authorize`,
      headers: asUser(staffA), payload: { clientId: clientA },
    });
    expect(authorizeBad.statusCode).toBe(400);

    const { state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });
    const callbackBad = await callback(staffA, { code: "irrelevant", state, provider: "google_bogus" });
    expect(callbackBad.statusCode).toBe(400);
  });

  // ── 3 · missing Cerbos permission (REAL Cerbos, not mocked) ──────────────────────────────────────
  it("a principal with no search-module grant cannot start an authorization (403, real Cerbos)", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/google_search_console/authorize`,
      headers: asUser(plainMemberA), payload: { clientId: clientA },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── 4 · the callback requires authentication ──────────────────────────────────────────────────────
  it("the callback 401s with no auth headers at all — Google's own redirect cannot carry one, but this route's caller must present one", async () => {
    const res = await app.inject({ method: "GET", url: `/api/search/google/oauth/callback?code=x&state=y&provider=google_search_console` });
    expect(res.statusCode).toBe(401);
  });

  // ── 4b · defense-in-depth: role revoked between start and complete ──────────────────────────────
  // This is the ONE case the pure state-signature/single-use/principal-bind trio (A1-A3) does NOT
  // close on its own: `staffTemp`'s own principal started the flow legitimately, so A1's created_by
  // check still matches. What must ALSO be checked is whether that principal is STILL permitted —
  // the extra Cerbos call this controller adds after `parseStateToken` and before
  // `completeAuthorization`.
  it("a principal whose search-module role is revoked after starting but before completing the flow is refused at the callback (403)", async () => {
    const staffTemp = await createUser(`staff-temp-${Date.now()}@sm25a-http.test`);
    await addMembership(tenantA, staffTemp);
    const tempRole = await createRole("search_staff"); // idempotent — returns the same global role row
    await grantRole(staffTemp, tempRole, "company", tenantA);

    const { code, state } = await startAndWalk({ tenantId: tenantA, userId: staffTemp, clientId: clientA });

    // Revoke: delete the grant row entirely (the DB-level equivalent of "unassigned this role").
    const { withGlobal } = await import("../../db");
    await withGlobal((c) => c.query(`DELETE FROM user_roles WHERE user_id = $1`, [staffTemp]));

    const res = await callback(staffTemp, { code, state, provider: "google_search_console" });
    expect(res.statusCode).toBe(403);
  });

  // ── 5 · forgery: corrupted signature, and a spliced tenant segment (attack A2) ───────────────────
  it("a state with a corrupted signature is refused with 400 before any exchange", async () => {
    const { state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });
    const parts = state.split(".");
    // Flip the FIRST character of the HMAC segment, not the last: base64url's final character of a
    // 32-byte (256-bit) digest carries two padding bits that decoding ignores, so flipping the LAST
    // character can — non-deterministically, depending which bit flips — decode to the SAME 32 bytes
    // and produce a flaky test. The first character has no such ambiguity.
    const firstChar = parts[3].slice(0, 1);
    parts[3] = (firstChar === "A" ? "B" : "A") + parts[3].slice(1);
    const forged = parts.join(".");
    const res = await callback(staffA, { code: "irrelevant-code", state: forged, provider: "google_search_console" });
    expect(res.statusCode).toBe(400);
  });

  it("a state whose TENANT segment is spliced to a different (real) tenant fails signature verification, not a tenant pivot", async () => {
    const { state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });
    const parts = state.split(".");
    const splicedTenant = Buffer.from(tenantB, "utf8").toString("base64url");
    const spliced = [parts[0], parts[1], splicedTenant, parts[3]].join(".");
    const res = await callback(staffA, { code: "irrelevant-code", state: spliced, provider: "google_search_console" });
    expect(res.statusCode).toBe(400);
  });

  // ── 6 · replay ─────────────────────────────────────────────────────────────────────────────────────
  it("a completed state cannot be replayed", async () => {
    const { code, state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });
    const first = await callback(staffA, { code, state, provider: "google_search_console" });
    expect(first.statusCode).toBe(200);
    const replay = await callback(staffA, { code, state, provider: "google_search_console" });
    expect(replay.statusCode).toBe(400);
  });

  // ── 7 · cross-tenant isolation on the connection routes ───────────────────────────────────────────
  it("a connection created in tenant A is invisible from tenant B, even for a principal who belongs to both", async () => {
    const { code, state } = await startAndWalk({ tenantId: tenantA, userId: staffBoth, clientId: clientA });
    const done = await callback(staffBoth, { code, state, provider: "google_search_console" });
    expect(done.statusCode).toBe(200);
    const connectionId = (done.json() as { id: string }).id;

    const crossTenantGet = await app.inject({
      method: "GET", url: `/api/${tenantB}/modules/search/google/connections/${connectionId}`, headers: asUser(staffBoth),
    });
    expect(crossTenantGet.statusCode).toBe(404);
  });

  // ── 8 · the two HTTP-layer FK/ownership guards ────────────────────────────────────────────────────
  it("starting authorization with a propertyId that belongs to a DIFFERENT client is rejected (400)", async () => {
    const propRes = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/properties`, headers: asUser(staffA),
      payload: { clientId: clientA2, domain: `sm25a-http-mismatch-${Date.now()}.example.com`, siteUrl: "https://sm25a-http.example.com" },
    });
    const propertyOfA2 = propRes.json().id as string;
    const res = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/google_search_console/authorize`,
      headers: asUser(staffA), payload: { clientId: clientA, propertyId: propertyOfA2 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("binding a connection to a property whose client differs from the connection's OWN client is rejected (400)", async () => {
    const { code, state } = await startAndWalk({ tenantId: tenantA, userId: staffA, clientId: clientA });
    const done = await callback(staffA, { code, state, provider: "google_search_console" });
    const connectionId = (done.json() as { id: string }).id; // owned by clientA

    const propRes = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/properties`, headers: asUser(staffA),
      payload: { clientId: clientA2, domain: `sm25a-http-bindmismatch-${Date.now()}.example.com`, siteUrl: "https://sm25a-http.example.com" },
    });
    const propertyOfA2 = propRes.json().id as string;

    const bind = await app.inject({
      method: "PUT", url: `/api/${tenantA}/modules/search/properties/${propertyOfA2}/google-connection/google_search_console`,
      headers: asUser(staffA), payload: { connectionId },
    });
    expect(bind.statusCode).toBe(400);
  });

  // ── 8b · malformed id/clientId format never reaches a query, so it is a 400 never a raw 500 ──────
  // Every uuid-typed column comparison ($1 = uuid) raises a raw Postgres 22P02 for a non-uuid literal,
  // which is not an HttpException and would surface as an unhandled 500 — the exact hazard
  // search.controller.ts's own header names for `assertUuid`. Checked on every new id-shaped param.
  it("a malformed clientId/connectionId/propertyId is rejected with 400, never a raw 500", async () => {
    const badClientId = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/google_search_console/authorize`,
      headers: asUser(staffA), payload: { clientId: "not-a-uuid" },
    });
    expect(badClientId.statusCode).toBe(400);

    const badGet = await app.inject({
      method: "GET", url: `/api/${tenantA}/modules/search/google/connections/not-a-uuid`, headers: asUser(staffA),
    });
    expect(badGet.statusCode).toBe(400);

    const badRefresh = await app.inject({
      method: "POST", url: `/api/${tenantA}/modules/search/google/connections/not-a-uuid/refresh`, headers: asUser(staffA),
    });
    expect(badRefresh.statusCode).toBe(400);

    const badBind = await app.inject({
      method: "PUT", url: `/api/${tenantA}/modules/search/properties/not-a-uuid/google-connection/google_search_console`,
      headers: asUser(staffA), payload: { connectionId: "also-not-a-uuid" },
    });
    expect(badBind.statusCode).toBe(400);
  });

  // ── 9 · Google's own consent-denial outcome ───────────────────────────────────────────────────────
  it("a `error=access_denied` callback is a clean 200, not an exception, and touches nothing", async () => {
    const res = await callback(staffA, { error: "access_denied" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "denied", error: "access_denied" });
  });

  it("a callback with no code and no error is a 400", async () => {
    const res = await callback(staffA, { state: "gs1.x.y.z", provider: "google_search_console" });
    expect(res.statusCode).toBe(400);
  });
});
