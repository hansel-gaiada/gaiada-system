// SM-25a / SM-51 — the OAuth core driven against a REAL, STANDARDS-COMPLIANT ISSUER: the local Keycloak
// `google-dev` realm client (design addendum §A12.3: "The machine path: YES").
//
// ── WHY THIS FILE EXISTS ALONGSIDE google-oauth.sandbox.test.ts ───────────────────────────────────
// The sandbox is OUR OWN MODEL of an issuer, so a green sandbox run cannot distinguish "our client is
// correct" from "our client and our model share the same misunderstanding" (§4i, transposed). Keycloak is
// an independent implementation of RFC 6749 / RFC 7636 / RFC 7009 that we did not write. So this file
// tests exactly the things where an independent implementation is worth more than a fixture:
//   * a REAL consent/login step, with a real HTML login form and real session cookies;
//   * real PKCE S256 enforcement, by an issuer configured to REQUIRE it;
//   * real refresh-token ROTATION (Keycloak rotates by default) and our persistence of it;
//   * real RFC-7009 revocation WITH CLIENT AUTHENTICATION — the branch in token-endpoint-client.ts
//     that sends client credentials for a non-Google host. Google's own /revoke documents a bare
//     `token=` body; the RFC requires a confidential client to authenticate; Keycloak enforces the RFC.
//     That branch is therefore proven against the party that actually enforces it.
//
// ── WHAT IT STILL DOES NOT PROVE (SM-41G, verbatim and unchanged) ────────────────────────────────
// Keycloak is not Google. This file does NOT establish: Google's consent screen, incremental consent, or
// what a Google scope STRING grants; refresh-token longevity under an OAuth app's publish status (a
// Testing-mode Google app's refresh tokens expire in 7 DAYS — Keycloak's lifespans are unrelated and
// cannot rehearse it); Google-side revocation behaviour; quota/429 handling; the Ads developer-token
// approval or MCC/login-customer-id semantics; or whether real Google accepts our serialized requests at
// all. A green run here is a validated client of the OAuth PROTOCOL against a real issuer — not a
// validated Google integration.
//
// ── PREREQUISITES (skips cleanly, and says why, rather than failing) ─────────────────────────────
//   * Keycloak up with the `gaiada` realm  (infra/compose: docker compose … up -d keycloak)
//   * the `google-dev` client provisioned   (infra/compose/keycloak/provision-google-dev-client.py)
//   * a dev user                            (infra/compose/keycloak/provision-dev-users.py)
//   * KEYCLOAK_OAUTH_TEST=1 plus GOOGLE_DEV_CLIENT_SECRET, so this never runs by accident in CI
//     against a Keycloak that has no such client (a silent skip is better than a confusing red).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startAuthorization, completeAuthorization, getAccessToken, revokeGoogleConnection } from "./oauth";

const KC_URL = process.env.KC_URL ?? "http://localhost:8080";
const KC_REALM = process.env.KC_REALM ?? "gaiada";
const KC_CLIENT_ID = process.env.GOOGLE_DEV_CLIENT_ID ?? "google-dev";
const KC_CLIENT_SECRET = process.env.GOOGLE_DEV_CLIENT_SECRET ?? "";
const KC_USER = process.env.KC_TEST_USER ?? "owner@gaiada-creative.test";
const KC_PASSWORD = process.env.KC_TEST_PASSWORD ?? "Passw0rd!";
// Any registered URI works: nothing listens on it. Keycloak validates the URI and redirects; the test
// reads the Location header, exactly as the platform's callback route will receive it in a browser.
const REDIRECT_URI = process.env.GOOGLE_DEV_REDIRECT_URI ?? "http://localhost:3004/api/search/google/oauth/callback";

const ENABLED = process.env.KEYCLOAK_OAUTH_TEST === "1" && !!KC_CLIENT_SECRET && !!TEST_URL;

/** Cookie jar just rich enough for one login: Keycloak's login form needs AUTH_SESSION_ID + KC_RESTART
 *  carried from the authorize response to the form POST. A real browser does this; here it is six lines. */
function jarFrom(res: Response, jar: Map<string, string>): void {
  // `getSetCookie` returns each Set-Cookie separately (Node 20+); the joined `get` would mangle them.
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

describe.skipIf(!ENABLED)("SM-25a · OAuth core against the REAL local Keycloak issuer (§A12.3 machine path)", () => {
  let tenant: string;
  let user: string;
  let client: string;
  let propertyId: string;
  const saved: Record<string, string> = {};

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");

    const g = config.search.google;
    saved.clientId = g.clientId;
    saved.clientSecret = g.clientSecret;
    saved.redirectUri = g.redirectUri;
    saved.authorizeUrl = g.authorizeUrl;
    saved.tokenUrl = g.tokenUrl;
    saved.revokeUrl = g.revokeUrl;

    g.clientId = KC_CLIENT_ID;
    g.clientSecret = KC_CLIENT_SECRET;
    g.redirectUri = REDIRECT_URI;
    g.authorizeUrl = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/auth`;
    g.tokenUrl = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`;
    g.revokeUrl = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/revoke`;

    tenant = await createCompany("SM-25a KC Agency", ["search"]);
    user = await createUser("kc-linker@sm25a.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "SM-25a KC Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, tenant, client, "kc-client.example", "https://kc-client.example/", config.originSite],
        ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    const g = config.search.google;
    g.clientId = saved.clientId;
    g.clientSecret = saved.clientSecret;
    g.redirectUri = saved.redirectUri;
    g.authorizeUrl = saved.authorizeUrl;
    g.tokenUrl = saved.tokenUrl;
    g.revokeUrl = saved.revokeUrl;
    await teardownTestDb();
  });

  /** Perform the REAL browser half: fetch the authorize URL, get Keycloak's HTML login page, submit the
   *  credentials to the form's own action URL, and read the authorization code out of the redirect.
   *  This is the one step a server cannot do for the user, so the test does it — everything on either
   *  side of it is our production code path, unmodified. */
  async function realLogin(authorizeUrl: string): Promise<string> {
    const jar = new Map<string, string>();
    const page = await fetch(authorizeUrl, { redirect: "manual" });
    jarFrom(page, jar);
    expect(page.status, "Keycloak should serve the login page").toBe(200);
    const html = await page.text();
    // The login form's action is an absolute `login-actions/authenticate?...` URL, HTML-escaped.
    const m = /action="([^"]+login-actions\/authenticate[^"]*)"/.exec(html);
    expect(m, "expected a Keycloak login form in the authorize response").not.toBeNull();
    const action = m![1].replace(/&amp;/g, "&");

    const submit = await fetch(action, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
      body: new URLSearchParams({ username: KC_USER, password: KC_PASSWORD, credentialId: "" }).toString(),
    });
    // 302 back to the registered redirect URI, carrying ?code=&state=
    expect(submit.status, "a successful login should redirect, not re-render the form").toBe(302);
    const loc = new URL(submit.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBeNull();
    const code = loc.searchParams.get("code");
    expect(code, "the redirect must carry an authorization code").toBeTruthy();
    return code!;
  }

  it("REAL authorization-code + PKCE round trip: consent → code → exchange → sealed in the existing vault", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, propertyId,
      // Keycloak has no `webmasters.readonly` client scope; `openid` is the scope every OIDC issuer
      // honours. The SCOPE STRING is the one thing a local issuer can never validate for us — what a
      // Google scope actually grants is SM-41G — so using a scope Keycloak accepts is the honest choice
      // rather than pretending a mirrored name proves anything.
      scopes: ["openid"],
      provider: "google_search_console",
      createdBy: user,
    });
    // §A12.2/§A12.3: Keycloak is not a Google host, so the row is stamped simulated and the issuer host
    // is recorded for the honesty line.
    expect(started.simulated).toBe(true);
    expect(started.issuerHost).toBe(new URL(KC_URL).host);
    // PKCE actually reached the real issuer's authorize request.
    expect(new URL(started.authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");

    const code = await realLogin(started.authorizeUrl);
    const connection = await completeAuthorization({
      stateToken: started.state, code, principalUserId: user, provider: "google_search_console",
    });

    expect(connection.status).toBe("linked");
    expect(connection.hasToken).toBe(true);
    // A REAL issuer issued a real refresh token — not a fixture that says it did.
    expect(connection.hasRefreshToken).toBe(true);
    expect(connection.issuerIsGoogle).toBe(false);
    expect(connection.issuerHost).toBe(new URL(KC_URL).host);

    // Sealed, not plaintext. Keycloak's tokens are JWTs, so a plaintext leak would be recognizable as
    // one — this asserts no `eyJ` prefix survives into the stored column.
    const raw = await withTenants([tenant], (c) =>
      c.query<{ access_token_enc: string; refresh_token_enc: string; token_key_version: string }>(
        `SELECT access_token_enc, refresh_token_enc, token_key_version FROM integration_connections WHERE id = $1`,
        [connection.id],
      ),
    );
    expect(raw.rows[0].access_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(raw.rows[0].refresh_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(raw.rows[0].access_token_enc).not.toContain("eyJ");
    expect(raw.rows[0].token_key_version).toBe("v1");
  }, 30000);

  it("REAL refresh with ROTATION: a chain of three refreshes succeeds, which only works if each rotation was stored", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_analytics", scopes: ["openid"], createdBy: user,
    });
    const code = await realLogin(started.authorizeUrl);
    const conn = await completeAuthorization({
      stateToken: started.state, code, principalUserId: user, provider: "google_analytics",
    });

    const seen = new Set<string>();
    const snapshot = async () =>
      (
        await withTenants([tenant], (c) =>
          c.query<{ refresh_token_enc: string }>(
            `SELECT refresh_token_enc FROM integration_connections WHERE id = $1`, [conn.id],
          ),
        )
      ).rows[0].refresh_token_enc;

    seen.add(await snapshot());
    // Keycloak rotates the refresh token on every use. If our persistence dropped a rotation, the NEXT
    // refresh would present a superseded token and Keycloak would answer invalid_grant — which our code
    // now maps to a 409 re-link. Three hops, so this is a chain rather than a single lucky hop.
    for (let i = 0; i < 3; i++) {
      const out = await getAccessToken(tenant, conn.id, { force: true });
      expect(out.refreshed).toBe(true);
      seen.add(await snapshot());
    }
    // Every hop stored a DIFFERENT ciphertext: 1 initial + 3 rotations.
    expect(seen.size).toBe(4);
  }, 45000);

  it("REAL RFC-7009 revocation WITH client authentication — the non-Google branch, proven against an issuer that enforces it", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_ads", scopes: ["openid"], createdBy: user,
    });
    const code = await realLogin(started.authorizeUrl);
    const conn = await completeAuthorization({
      stateToken: started.state, code, principalUserId: user, provider: "google_ads",
    });

    const out = await revokeGoogleConnection(tenant, conn.id);
    // Keycloak REQUIRES client authentication at /revoke (RFC 7009 §2.1). token-endpoint-client.ts sends
    // client credentials because the host is not Google's; if that branch were wrong, this would be a
    // 401 and `issuerRevoked` would be false. This is the assertion that branch exists for.
    expect(out.issuerRevoked).toBe(true);
    expect(out.issuerStatus).toBe(200);
    expect(out.connection.status).toBe("revoked");
    expect(out.connection.hasToken).toBe(false);
    expect(out.connection.hasRefreshToken).toBe(false);

    // And the grant is genuinely gone at the issuer: the vault no longer holds tokens, so a use attempt
    // is a 409 re-link rather than a silent success against a still-live grant.
    await expect(getAccessToken(tenant, conn.id)).rejects.toMatchObject({
      status: 409, code: "google_connection_not_linked",
    });
  }, 30000);

  it("REAL PKCE enforcement: the issuer refuses an exchange whose verifier does not match the challenge", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", scopes: ["openid"], createdBy: user,
    });
    const code = await realLogin(started.authorizeUrl);

    // Start a SECOND flow and complete the FIRST code with the second flow's state — i.e. present a
    // valid-but-wrong code_verifier. Our state row is consumed (so the callback half passes), and the
    // refusal must come from KEYCLOAK's own PKCE check, not from our code.
    const other = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", scopes: ["openid"], createdBy: user,
    });
    await expect(
      completeAuthorization({
        stateToken: other.state, code, principalUserId: user, provider: "google_search_console",
      }),
    ).rejects.toMatchObject({ status: 502, code: "google_token_endpoint_error" });
    // Unused, but consumed deliberately so the first flow's state does not linger redeemable.
    void started;
  }, 45000);
});
