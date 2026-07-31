// SM-25a — THE FULL CHAIN, through the REAL client, against SM-51's sandbox on real sockets and a real
// Postgres: authorize → code → exchange → seal into the EXISTING vault → authorized API call →
// refresh-on-401 → rotation persisted → RFC-7009 revoke (design addendum §A12).
//
// WHY THIS FILE NEEDS POSTGRES (and google-sandbox-harness.test.ts does not): everything under test here
// is a PERSISTENCE property — the single-use state row, FORCE-RLS tenancy, sealed-not-plaintext token
// storage, and above all ROTATION PERSISTENCE, which is unobservable without a database because the bug
// it guards against is "the new refresh token was received and not written down".
//
// ⚠ BINDING (§A12.5): a green run of this file is a validated client of OUR OWN MODEL OF GOOGLE, NOT a
// validated Google integration. Fixture and parser agree by construction. Every one of the following is
// UNPROVEN here and deferred to SM-41G: Google's consent screen; incremental consent and what a scope
// STRING actually grants; refresh-token longevity under the OAuth app's publish status (a Testing-mode
// app's refresh tokens expire in 7 days — a production-behaviour fact no local issuer can rehearse);
// Google-side revocation behaviour; quota/429 handling; the Ads developer-token approval and
// MCC/login-customer-id semantics; and whether real Google accepts our serialized requests at all.
// No test name below may be read as covering any of them.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { startGoogleSandbox, type GoogleSandbox } from "../../../testing/vendor-sandbox/google-server";
import { GoogleConnectionNotLinkedError, GoogleOAuthNotConfiguredError, GoogleOAuthStateError } from "./errors";
import { signStateToken } from "./oauth-state";
import {
  completeAuthorization,
  getAccessToken,
  listGoogleConnections,
  refreshConnection,
  resolvePropertyConnection,
  revokeGoogleConnection,
  startAuthorization,
} from "./oauth";
import { searchConsoleQuery, searchConsoleListSites, ga4RunReport, adsSearch, googleAuthorizedRequest } from "./api-client";

const CLIENT_ID = "sm25a-google-dev";
const CLIENT_SECRET = "sm25a-google-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const SITE_URL = "https://sandbox-client.example/";

describe.skipIf(!TEST_URL)("SM-25a · Google OAuth core, full chain against the SM-51 sandbox", () => {
  let sb: GoogleSandbox;
  let tenant: string;
  let otherTenant: string;
  let user: string;
  let otherUser: string;
  let client: string;
  let propertyId: string;

  beforeAll(async () => {
    await initTestDb();
    // The vault key: without it nothing can be sealed, and the OAuth state signature has no key to
    // derive from — both fail closed. Set to a real 32-byte key for the happy path.
    config.integrationTokenKey = randomBytes(32).toString("base64");

    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    // Point the CONFIG SEAMS at the sandbox — the real client's real default HTTP path then runs against
    // it. This is the §A12.3 mechanism, and the §A10.4 boot guard (extended by endpoint-guard.ts) is
    // what stops the same repointing from being possible in a deployed live stack.
    config.search.google.clientId = CLIENT_ID;
    config.search.google.clientSecret = CLIENT_SECRET;
    config.search.google.redirectUri = REDIRECT_URI;
    config.search.google.authorizeUrl = sb.endpoints.authorizeUrl;
    config.search.google.tokenUrl = sb.endpoints.tokenUrl;
    config.search.google.revokeUrl = sb.endpoints.revokeUrl;
    config.search.google.searchConsoleBaseUrl = sb.endpoints.searchConsoleBaseUrl;
    config.search.google.analyticsDataBaseUrl = sb.endpoints.analyticsDataBaseUrl;
    config.search.google.adsBaseUrl = sb.endpoints.adsBaseUrl;

    tenant = await createCompany("SM-25a Agency", ["search"]);
    otherTenant = await createCompany("SM-25a Rival", ["search"]);
    user = await createUser("linker@sm25a.test");
    otherUser = await createUser("bystander@sm25a.test");
    await addMembership(tenant, user);
    await addMembership(tenant, otherUser);
    client = await createClient(tenant, "SM-25a Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [propertyId, tenant, client, "sandbox-client.example", SITE_URL, config.originSite],
        ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    // Guarded: if beforeAll dies (e.g. an unreachable test Postgres) `sb` is undefined, and an
    // unguarded teardown then reports a misleading TypeError on top of the real failure.
    if (sb) await sb.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    sb.resetHitCounts();
  });

  /** Walk the issuer's authorize redirect the way a browser would, and return the code it hands back.
   *  This is the ONLY step a server cannot perform for the user, so the test performs it — everything
   *  before and after is our real production code path. */
  async function walkConsent(authorizeUrl: string): Promise<{ code: string; state: string }> {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBeNull();
    return { code: loc.searchParams.get("code")!, state: loc.searchParams.get("state")! };
  }

  async function linkGsc(opts: { withProperty?: boolean; asUser?: string } = {}) {
    const started = await startAuthorization({
      tenantId: tenant,
      clientId: client,
      propertyId: opts.withProperty ? propertyId : null,
      provider: "google_search_console",
      createdBy: opts.asUser ?? user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    const connection = await completeAuthorization({
      stateToken: state,
      code,
      principalUserId: opts.asUser ?? user,
      provider: "google_search_console",
    });
    return { started, connection };
  }

  // ── 1 · authorize URL + state row ───────────────────────────────────────────────────────────────

  it("startAuthorization builds a PKCE-S256 authorize URL and records a state row stamped simulated=true", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    // Google-specific, and what makes a refresh token arrive at all.
    expect(url.searchParams.get("access_type")).toBe("offline");

    // §A12.2 PROVENANCE: the sandbox origin is not a Google host, so the row says so. This is the
    // "audience, not label" ruling transposed — the row is honest about what it descends from, and it
    // exists only in this file's throwaway database.
    expect(started.simulated).toBe(true);
    expect(started.issuerHost).toBe(new URL(sb.origin).host);

    const rows = await withTenants(
      [tenant],
      (c) => c.query<{ simulated: boolean; issuer_host: string; code_challenge_method: string; consumed_at: string | null; code_verifier_enc: string }>(
        `SELECT simulated, issuer_host, code_challenge_method, consumed_at, code_verifier_enc
           FROM search_google_oauth_states ORDER BY created_at DESC LIMIT 1`,
      ),
      { modules: ["search"] },
    );
    expect(rows.rows[0].simulated).toBe(true);
    expect(rows.rows[0].code_challenge_method).toBe("S256");
    expect(rows.rows[0].consumed_at).toBeNull();
    // The PKCE verifier is SEALED at rest, not plaintext — reading the row is not enough to complete
    // someone else's in-flight exchange.
    expect(rows.rows[0].code_verifier_enc.startsWith("enc:v1:")).toBe(true);
  });

  // ── 2 · exchange + vault ────────────────────────────────────────────────────────────────────────

  it("completeAuthorization seals tokens into the EXISTING 0033 vault as owner_kind='client' — ciphertext, never plaintext", async () => {
    const { connection } = await linkGsc();
    expect(connection.status).toBe("linked");
    expect(connection.hasToken).toBe(true);
    expect(connection.hasRefreshToken).toBe(true);
    expect(connection.provider).toBe("google_search_console");
    expect(connection.clientId).toBe(client);
    // §A12.3's honesty rule: a dev-issuer connection is readable as one at a glance.
    expect(connection.issuerIsGoogle).toBe(false);
    expect(connection.issuerHost).toBe(new URL(sb.origin).host);

    const raw = await withTenants([tenant], (c) =>
      c.query<{ owner_kind: string; owner_id: string; provider: string; status: string; access_token_enc: string; refresh_token_enc: string; token_key_version: string; token_expires_at: string }>(
        `SELECT owner_kind, owner_id, provider, status, access_token_enc, refresh_token_enc,
                token_key_version, token_expires_at
           FROM integration_connections WHERE id = $1`,
        [connection.id],
      ),
    );
    const r = raw.rows[0];
    // 0035's widened CHECKs are what make these two values legal; this asserts we actually use them.
    expect(r.owner_kind).toBe("client");
    expect(r.owner_id).toBe(client);
    expect(r.provider).toBe("google_search_console");
    expect(r.status).toBe("linked");
    expect(r.token_key_version).toBe("v1");
    expect(r.token_expires_at).not.toBeNull();
    // The tokens are AES-256-GCM envelopes. Critically, the sandbox's own opaque token strings must NOT
    // appear anywhere in the stored columns.
    expect(r.access_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(r.refresh_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(r.access_token_enc).not.toContain("sm51-at-");
    expect(r.refresh_token_enc).not.toContain("sm51-rt-");
  });

  it("NO Google row ever lands in search_data_cache — that table is no-RLS shared market data (D-4)", async () => {
    const { connection } = await linkGsc();
    await searchConsoleQuery({
      tenantId: tenant, connectionId: connection.id, siteUrl: SITE_URL,
      startDate: "2026-07-01", endDate: "2026-07-29", dimensions: ["query"], rowLimit: 10,
    });
    // The whole ticket's most expensive possible mistake, asserted directly rather than argued: a
    // client's private Search Console rows in a cross-tenant no-RLS cache would be a leak BY
    // CONSTRUCTION. The Google path does not go through dispatchProviderOp, so it has no cache write
    // path at all — this pins that structural fact against a future "let's cache GSC too".
    const cache = await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_data_cache`));
    expect(Number(cache.rows[0].n)).toBe(0);
    // And no USD ledger row either: there are no dollars to meter on a client's own Google account
    // (§A12.1), so inventing one would corrupt §A3's cost-to-serve meaning.
    const ledger = await withTenants(
      [tenant],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_provider_calls`),
      { modules: ["search"] },
    );
    expect(Number(ledger.rows[0].n)).toBe(0);
  });

  // ── 3 · the callback attack list (§4g) ─────────────────────────────────────────────────────────

  it("A3 · REPLAY: the same state cannot be redeemed twice (single-use, atomic)", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    await completeAuthorization({ stateToken: state, code, principalUserId: user, provider: "google_search_console" });

    await expect(
      completeAuthorization({ stateToken: state, code, principalUserId: user, provider: "google_search_console" }),
    ).rejects.toMatchObject({ status: 400, code: "google_oauth_invalid_state" });
  });

  it("A2 · FORGERY: a state naming a tenant but signed with the wrong key is refused before any DB read", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const { code } = await walkConsent(started.authorizeUrl);

    // Re-sign the SAME state id under a different vault key — i.e. an attacker who knows the id (or
    // guesses one) but not the signing secret.
    const realKey = config.integrationTokenKey;
    config.integrationTokenKey = randomBytes(32).toString("base64");
    const forged = signStateToken(started.state.split(".")[1], tenant); // whatever id, wrong key
    config.integrationTokenKey = realKey;

    await expect(
      completeAuthorization({ stateToken: forged, code, principalUserId: user, provider: "google_search_console" }),
    ).rejects.toBeInstanceOf(GoogleOAuthStateError);
    // A hand-built token with no signature at all is equally refused.
    await expect(
      completeAuthorization({ stateToken: "gs1.abc.def.ghi", code, principalUserId: user, provider: "google_search_console" }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state" });
  });

  it("A1 · CSRF: the callback refuses a principal who did not start the flow", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    // Without this check, an attacker who drives a victim's browser to the callback with the ATTACKER's
    // own authorization code binds the attacker's Google account into the victim's tenant.
    await expect(
      completeAuthorization({ stateToken: state, code, principalUserId: otherUser, provider: "google_search_console" }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state" });
  });

  it("A6 · PROVIDER CONFUSION: a Search Console state cannot be redeemed as an Ads connection", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    await expect(
      completeAuthorization({ stateToken: state, code, principalUserId: user, provider: "google_ads" }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state" });
  });

  it("A7 · CROSS-TENANT: a state row for tenant A is invisible from tenant B (FORCE RLS on 0060)", async () => {
    await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    const mine = await withTenants(
      [tenant],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
      { modules: ["search"] },
    );
    expect(Number(mine.rows[0].n)).toBeGreaterThan(0);
    const theirs = await withTenants(
      [otherTenant],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
      { modules: ["search"] },
    );
    expect(Number(theirs.rows[0].n)).toBe(0);
  });

  it("the module wall is real: without modules:['search'] the state table reads ZERO rows, never a leak", async () => {
    await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user,
    });
    // app_module_allowed('search') is the third wall (0034's policy shape, reused verbatim by 0060).
    // Omitting the module scope must fail CLOSED — this is the property that makes forgetting it a
    // zero-row bug rather than a cross-module read.
    const unscoped = await withTenants([tenant], (c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
    );
    expect(Number(unscoped.rows[0].n)).toBe(0);
  });

  // ── 4 · authorized calls: Search Console, then GA4, then the Ads read ──────────────────────────

  it("Search Console: an authorized query runs the REAL client path and returns the documented envelope", async () => {
    const { connection } = await linkGsc();
    const sites = await searchConsoleListSites<{ siteEntry: Array<{ siteUrl: string }> }>({
      tenantId: tenant, connectionId: connection.id,
    });
    expect(sites.status).toBe(200);
    expect(sites.data.siteEntry.some((s) => s.siteUrl === SITE_URL)).toBe(true);

    const q = await searchConsoleQuery<{ rows: Array<{ keys: string[]; ctr: number; position: number }> }>({
      tenantId: tenant, connectionId: connection.id, siteUrl: SITE_URL,
      startDate: "2026-07-01", endDate: "2026-07-29", dimensions: ["query"], rowLimit: 25,
    });
    expect(q.status).toBe(200);
    expect(q.refreshed).toBe(false); // a fresh token needs no renewal
    expect(q.data.rows.length).toBeGreaterThan(0);
    expect(q.data.rows[0].ctr).toBeLessThanOrEqual(1);
    expect(sb.hitCount("gsc:search_analytics")).toBe(1);
  });

  it("GA4: runReport is reached with the same credential and returns string-valued metrics", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_analytics", createdBy: user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    const conn = await completeAuthorization({ stateToken: state, code, principalUserId: user, provider: "google_analytics" });

    const rep = await ga4RunReport<{ rows: Array<{ metricValues: Array<{ value: string }> }> }>({
      tenantId: tenant, connectionId: conn.id, propertyId: "424242",
      body: { dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-29" }], metrics: [{ name: "sessions" }] },
    });
    expect(rep.status).toBe(200);
    expect(typeof rep.data.rows[0].metricValues[0].value).toBe("string");
    expect(sb.hitCount("ga4:run_report")).toBe(1);
  });

  it("Ads READ: googleAds:search is reached; a MUTATE path is structurally refused by our own client", async () => {
    const started = await startAuthorization({
      tenantId: tenant, clientId: client, provider: "google_ads", createdBy: user,
    });
    const { code, state } = await walkConsent(started.authorizeUrl);
    const conn = await completeAuthorization({ stateToken: state, code, principalUserId: user, provider: "google_ads" });

    const read = await adsSearch<{ results: Array<{ metrics: { cost_micros: string } }> }>({
      tenantId: tenant, connectionId: conn.id, customerId: "1234567890",
      query: "SELECT campaign.id, metrics.cost_micros FROM campaign",
    });
    expect(read.status).toBe(200);
    expect(typeof read.data.results[0].metrics.cost_micros).toBe("string");

    // Ads WRITES are governed by SM-21's approve-execute-replay + WS4 one-shot approval regardless of
    // transport (§A12.1/D-8), and this ticket does not open that path. The read helper refuses a
    // mutate-shaped path outright rather than leaving it to convention — the sandbox WOULD serve it
    // (proven in google-sandbox-harness.test.ts), so this refusal is our code's, not the harness's.
    await expect(
      googleAuthorizedRequest({
        tenantId: tenant, connectionId: conn.id, surface: "ads",
        path: "/v18/customers/1234567890/campaigns:mutate", method: "POST", body: { operations: [] },
      }),
    ).rejects.toThrow(/SM-21/);
    expect(sb.hitCount("ads:mutate")).toBe(0);
  });

  // ── 5 · refresh-on-401 + rotation persistence ─────────────────────────────────────────────────

  it("REFRESH-ON-401: an expired access token is renewed mid-flight and the call succeeds on one retry", async () => {
    const { connection } = await linkGsc();
    // Kill the access token WITHOUT touching the refresh token — the exact state a real expiry produces
    // between our stored expiry and the surface's own view.
    expect(sb.expireAccessTokens()).toBeGreaterThan(0);
    sb.resetHitCounts();

    const q = await searchConsoleQuery<{ rows: unknown[] }>({
      tenantId: tenant, connectionId: connection.id, siteUrl: SITE_URL,
      startDate: "2026-07-01", endDate: "2026-07-29",
    });
    expect(q.status).toBe(200);
    expect(q.refreshed).toBe(true);
    // Proven by the machine's own counters, not inferred from a green result: exactly one 401 refusal,
    // one token-endpoint refresh, and two attempts at the surface.
    expect(sb.hitCount("gsc:search_analytics:auth_refused")).toBe(1);
    expect(sb.hitCount("google:token")).toBe(1);
    expect(sb.hitCount("gsc:search_analytics")).toBe(2);
  });

  it("ROTATION IS PERSISTED: a SECOND refresh succeeds, which is only possible if the first rotation was stored", async () => {
    const { connection } = await linkGsc();

    const before = await withTenants([tenant], (c) =>
      c.query<{ refresh_token_enc: string }>(`SELECT refresh_token_enc FROM integration_connections WHERE id = $1`, [connection.id]),
    );

    // First refresh: the sandbox rotates (default), so a NEW refresh token comes back and the old one dies.
    const r1 = await getAccessToken(tenant, connection.id, { force: true });
    expect(r1.refreshed).toBe(true);
    expect(sb.hitCount("google:token_rotated")).toBe(1);

    const after = await withTenants([tenant], (c) =>
      c.query<{ refresh_token_enc: string }>(`SELECT refresh_token_enc FROM integration_connections WHERE id = $1`, [connection.id]),
    );
    // The stored ciphertext changed — the rotation was written down.
    expect(after.rows[0].refresh_token_enc).not.toBe(before.rows[0].refresh_token_enc);

    // THE ACTUAL PROOF: refresh again. If the rotation had not been persisted we would now be presenting
    // the superseded token, and the sandbox refuses it (invalid_grant) — this is the classic rotation bug,
    // and it is invisible to any single-refresh test.
    const r2 = await getAccessToken(tenant, connection.id, { force: true });
    expect(r2.refreshed).toBe(true);
    expect(sb.hitCount("google:token_rotated")).toBe(2);
    expect(sb.hitCount("google:token_refresh_refused")).toBe(0);

    // And a third, for good measure — a chain, not a single hop.
    await expect(getAccessToken(tenant, connection.id, { force: true })).resolves.toMatchObject({ refreshed: true });
    expect(sb.hitCount("google:token_refresh_refused")).toBe(0);
  });

  it("refreshConnection surfaces the masked view and never token material", async () => {
    const { connection } = await linkGsc();
    const view = await refreshConnection(tenant, connection.id);
    expect(view.hasToken).toBe(true);
    expect(view.tokenExpiresAt).not.toBeNull();
    // The masked shape has no token field at all — structurally, not by omission.
    expect(JSON.stringify(view)).not.toContain("sm51-at-");
    expect(JSON.stringify(view)).not.toContain("sm51-rt-");
  });

  // ── 6 · revocation ────────────────────────────────────────────────────────────────────────────

  it("REVOKE: RFC-7009 at the issuer, then the local row — and the connection becomes unusable", async () => {
    const { connection } = await linkGsc();
    const out = await revokeGoogleConnection(tenant, connection.id);
    expect(out.issuerRevoked).toBe(true);
    expect(out.issuerStatus).toBe(200);
    expect(out.connection.status).toBe("revoked");
    expect(out.connection.hasToken).toBe(false);
    expect(out.connection.hasRefreshToken).toBe(false);
    expect(sb.hitCount("google:revoke")).toBe(1);

    // Tokens are NULLED in the vault, not merely flagged.
    const raw = await withTenants([tenant], (c) =>
      c.query<{ access_token_enc: string | null; refresh_token_enc: string | null }>(
        `SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE id = $1`, [connection.id],
      ),
    );
    expect(raw.rows[0].access_token_enc).toBeNull();
    expect(raw.rows[0].refresh_token_enc).toBeNull();

    // And the connection now refuses use with a 409 that tells a human to re-link, not a 500.
    await expect(getAccessToken(tenant, connection.id)).rejects.toMatchObject({
      status: 409, code: "google_connection_not_linked",
    });
  });

  it("REVOKE is not defeated by an unreachable issuer: the local credential is destroyed regardless", async () => {
    const { connection } = await linkGsc();
    const goodRevokeUrl = config.search.google.revokeUrl;
    // A revoke endpoint that answers nothing. Refusing to FORGET a credential because a remote endpoint
    // is down would be the wrong failure direction for a vault, so the local wipe must still happen and
    // the issuer outcome must be REPORTED rather than swallowed.
    config.search.google.revokeUrl = `${sb.origin}/not-a-revocation-endpoint`;
    try {
      const out = await revokeGoogleConnection(tenant, connection.id);
      expect(out.issuerRevoked).toBe(false);
      expect(out.connection.status).toBe("revoked");
      expect(out.connection.hasToken).toBe(false);
    } finally {
      config.search.google.revokeUrl = goodRevokeUrl;
    }
  });

  it("a Google-side revocation (grant killed behind our back) surfaces as 409 re-link, not a crash", async () => {
    const { connection } = await linkGsc();
    // Models the state SM-41G must observe for real: Google ends the grant, our vault still holds tokens.
    sb.revokeAllGrants();
    await expect(
      searchConsoleQuery({
        tenantId: tenant, connectionId: connection.id, siteUrl: SITE_URL,
        startDate: "2026-07-01", endDate: "2026-07-29",
      }),
    ).rejects.toBeInstanceOf(GoogleConnectionNotLinkedError);
  });

  // ── 7 · property bindings + listing ───────────────────────────────────────────────────────────

  it("a flow that names a property BINDS it, so gsc_connection_id resolves immediately", async () => {
    const { connection } = await linkGsc({ withProperty: true });
    await expect(resolvePropertyConnection(tenant, propertyId, "google_search_console")).resolves.toBe(connection.id);
    // Not cross-wired into the other two columns.
    await expect(resolvePropertyConnection(tenant, propertyId, "google_analytics")).resolves.toBeNull();
    // And invisible from another tenant (the FK-outside-RLS hazard search.controller.ts documents).
    await expect(resolvePropertyConnection(otherTenant, propertyId, "google_search_console")).resolves.toBeNull();
  });

  it("listGoogleConnections shows revoked rows too — 'was revoked' and 'never linked' are different facts", async () => {
    const rows = await listGoogleConnections(tenant, client);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(["google_search_console", "google_analytics", "google_ads"]).toContain(r.provider);
      // Every row carries the issuer disclosure §A12.3 requires.
      expect(r.issuerIsGoogle).toBe(false);
      expect(r.issuerHost).toBe(new URL(sb.origin).host);
    }
    // Tenant isolation on the read path too.
    await expect(listGoogleConnections(otherTenant, client)).resolves.toEqual([]);
  });

  // ── 8 · FAIL-CLOSED WHEN UNCONFIGURED ─────────────────────────────────────────────────────────

  it("FAIL-CLOSED: with no OAuth client configured every entry point throws a 503-mapped domain error", async () => {
    const saved = { id: config.search.google.clientId, secret: config.search.google.clientSecret, redirect: config.search.google.redirectUri };
    config.search.google.clientId = "";
    try {
      // Not a bare Error: a typed GoogleSurfaceError carrying status 503 + a stable code, so
      // GoogleOAuthErrorFilter maps it instead of it escaping as the body-less 500 this module has
      // already fixed twice (SM-53, SM-57).
      await expect(
        startAuthorization({ tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user }),
      ).rejects.toBeInstanceOf(GoogleOAuthNotConfiguredError);
      await expect(
        startAuthorization({ tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user }),
      ).rejects.toMatchObject({ status: 503, code: "google_oauth_not_configured" });
      // And it fails BEFORE writing anything: no half-started authorization request is left behind.
      const before = await withTenants(
        [tenant],
        (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
        { modules: ["search"] },
      );
      await expect(
        startAuthorization({ tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user }),
      ).rejects.toBeInstanceOf(GoogleOAuthNotConfiguredError);
      const after = await withTenants(
        [tenant],
        (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
        { modules: ["search"] },
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      config.search.google.clientId = saved.id;
      config.search.google.clientSecret = saved.secret;
      config.search.google.redirectUri = saved.redirect;
    }
  });

  it("FAIL-CLOSED: with no vault key, nothing can be sealed and no state row is created", async () => {
    const key = config.integrationTokenKey;
    config.integrationTokenKey = "";
    try {
      // encryptSecret() throws 503 (ServiceUnavailableException, an HttpException that HttpErrorFilter
      // already maps) — a PKCE verifier can never land unencrypted, exactly like a token.
      await expect(
        startAuthorization({ tenantId: tenant, clientId: client, provider: "google_search_console", createdBy: user }),
      ).rejects.toThrow(/vault not configured|not configured/i);
    } finally {
      config.integrationTokenKey = key;
    }
  });
});
