// QA ADVERSARIAL PASS (independent of the SM-51/SM-25a dev-authored suites) — attacks the prior gate's
// report said were HELD, plus the ones it did not attempt at the level that actually proves them:
//
//  1. Credential/token leakage from an ERROR path: a token endpoint that returns a malicious envelope
//     (client_secret / refresh_token / access_token baked into `error_description`, which some real
//     issuers do echo) must not have that material survive into GoogleTokenEndpointError's message or
//     `detail`. token-endpoint-client.ts's own header claims only the OAuth `error` CODE is surfaced,
//     never `error_description` — this proves it against a hostile server, not a cooperative fixture.
//  2b. One tampered byte of an otherwise-valid state token's HMAC segment.
//  2c. A state row whose `consumed_at` is set DIRECTLY IN THE DATABASE (bypassing the atomic UPDATE
//      entirely) — consumeAuthorizationState must still refuse it, proving the predicate re-checks
//      `consumed_at IS NULL` rather than trusting an in-process "I already spent this" flag.
//  2d. TRUE concurrency: two consumeAuthorizationState() calls fired via Promise.all against the SAME
//      state row. A JS-level mutex would not prove atomicity — this proves the DB's
//      `UPDATE ... WHERE consumed_at IS NULL RETURNING` is what decides the single winner.
//  2f. An EXPIRED state, backdated directly in the DB (not merely waiting out a TTL) — must fail exactly
//      like an unknown state (no oracle distinguishing "expired" from "never existed").
//  5.  FORCE-RLS on search_google_oauth_states, explicitly confirmed to run over the `platform_app_test`
//      role (NOSUPERUSER NOBYPASSRLS — see testing/setup.ts) and not a superuser connection: a tenant-B
//      session whose GUC never named tenant A must foreclose a targeted read of tenant A's row BY ID,
//      not merely return an empty COUNT(*) (a COUNT alone can't distinguish "filtered by RLS" from
//      "filtered by an app-level WHERE that happens to match nothing").
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { config } from "../../../config";
import { withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { GoogleOAuthStateError, GoogleTokenEndpointError } from "./errors";
import { consumeAuthorizationState, createAuthorizationState, signStateToken } from "./oauth-state";
import { exchangeAuthorizationCode, refreshAccessToken } from "./token-endpoint-client";

describe.skipIf(!TEST_URL)("QA adversarial pass · SM-25a/SM-51 Google OAuth core", () => {
  let tenant: string;
  let otherTenant: string;
  let user: string;
  let client: string;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    tenant = await createCompany("QA-Adversarial Agency", ["search"]);
    otherTenant = await createCompany("QA-Adversarial Rival", ["search"]);
    user = await createUser("qa-adversarial-linker@sm25a.test");
    await addMembership(tenant, user);
    client = await createClient(tenant, "QA-Adversarial Client");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function issueState(t: string = tenant) {
    return createAuthorizationState({
      tenantId: t,
      clientId: client,
      provider: "google_search_console",
      redirectUri: "http://127.0.0.1:3004/api/search/google/oauth/callback",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", // real Google host ⇒ simulated=false path unused here; irrelevant to this attack
      createdBy: user,
    });
  }

  const EXPECT = {
    redirectUri: "http://127.0.0.1:3004/api/search/google/oauth/callback",
    principalUserId: null as string | null,
    provider: "google_search_console" as const,
  };

  // ── 1 · credential leakage from a hostile token-endpoint error envelope ───────────────────────────

  describe("1 · error-path credential leakage", () => {
    let server: Server;
    let url: string;
    const POISON_SECRET = "LEAKED-CLIENT-SECRET-zzq93";
    const POISON_REFRESH = "LEAKED-REFRESH-TOKEN-zzq93";
    const POISON_ACCESS = "LEAKED-ACCESS-TOKEN-zzq93";

    beforeAll(async () => {
      server = createServer((req, res) => {
        // A hostile/misconfigured issuer that echoes request material (client_secret, refresh_token) and
        // an access token straight into error_description — the exact leak shape a filter must strip.
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: "invalid_grant",
            error_description:
              `client_secret=${POISON_SECRET} refresh_token=${POISON_REFRESH} access_token=${POISON_ACCESS}`,
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      url = `http://127.0.0.1:${port}/token`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("exchangeAuthorizationCode: the thrown error's message + detail never contain the poisoned envelope", async () => {
      const saved = { ...config.search.google };
      config.search.google.clientId = "qa-leak-test";
      config.search.google.clientSecret = "qa-leak-test-secret";
      config.search.google.redirectUri = "http://127.0.0.1:3004/cb";
      config.search.google.tokenUrl = url;
      try {
        let caught: unknown;
        try {
          await exchangeAuthorizationCode({ code: "x", codeVerifier: "y", redirectUri: "http://127.0.0.1:3004/cb" });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(GoogleTokenEndpointError);
        const err = caught as GoogleTokenEndpointError;
        const serialized = JSON.stringify({ message: err.message, detail: err.detail, code: err.code });
        expect(serialized).not.toContain(POISON_SECRET);
        expect(serialized).not.toContain(POISON_REFRESH);
        expect(serialized).not.toContain(POISON_ACCESS);
        expect(serialized).not.toContain("error_description");
        // What SHOULD survive: the OAuth error code, for caller branching.
        expect(err.detail?.oauthError).toBe("invalid_grant");
      } finally {
        Object.assign(config.search.google, saved);
      }
    });

    it("refreshAccessToken: same poisoned envelope, same non-leak guarantee", async () => {
      const saved = { ...config.search.google };
      config.search.google.clientId = "qa-leak-test";
      config.search.google.clientSecret = "qa-leak-test-secret";
      config.search.google.redirectUri = "http://127.0.0.1:3004/cb";
      config.search.google.tokenUrl = url;
      try {
        let caught: unknown;
        try {
          await refreshAccessToken("some-refresh-token");
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(GoogleTokenEndpointError);
        const err = caught as GoogleTokenEndpointError;
        const serialized = JSON.stringify({ message: err.message, detail: err.detail });
        expect(serialized).not.toContain(POISON_SECRET);
        expect(serialized).not.toContain(POISON_REFRESH);
        expect(serialized).not.toContain(POISON_ACCESS);
      } finally {
        Object.assign(config.search.google, saved);
      }
    });

    it("GoogleTokenEndpointError.detail structurally has no field capable of carrying error_description", () => {
      const err = new GoogleTokenEndpointError("exchange", 400, "invalid_grant");
      // Pin the shape: only operation/httpStatus/oauthError. A future edit that widens this to pass through
      // more of the raw body would be a silent reintroduction of the leak this test guards against.
      expect(Object.keys(err.detail ?? {}).sort()).toEqual(["httpStatus", "oauthError", "operation"]);
    });
  });

  // ── 2b · tampered HMAC byte ────────────────────────────────────────────────────────────────────────

  it("2b · TAMPER: flipping one byte of a valid state token's signature segment is refused", async () => {
    const state = await issueState();
    const token = signStateToken(state.stateId, tenant);
    const parts = token.split(".");
    expect(parts.length).toBe(4);
    // Flip one character deep inside the signature segment (base64url alphabet-safe swap).
    const sig = parts[3];
    const tamperIdx = Math.floor(sig.length / 2);
    const ch = sig[tamperIdx];
    const swapped = ch === "A" ? "B" : "A";
    parts[3] = sig.slice(0, tamperIdx) + swapped + sig.slice(tamperIdx + 1);
    const tampered = parts.join(".");
    expect(tampered).not.toBe(token);

    await expect(
      consumeAuthorizationState(tampered, { ...EXPECT, principalUserId: user }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state", detail: { reason: "bad_signature" } });
  });

  // ── 2c · consumed_at set directly in the DB, bypassing the app's atomic UPDATE ────────────────────

  it("2c · REPLAY VIA DIRECT DB WRITE: a row hand-marked consumed_at is refused exactly like a real replay", async () => {
    const state = await issueState();
    const token = signStateToken(state.stateId, tenant);

    await withTenants(
      [tenant],
      (c) => c.query(`UPDATE search_google_oauth_states SET consumed_at = now() WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );

    await expect(
      consumeAuthorizationState(token, { ...EXPECT, principalUserId: user }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state", detail: { reason: "unknown_or_expired" } });
  });

  // ── 2d · true concurrency: race two consumes against the same row ────────────────────────────────

  it("2d · CONCURRENT RACE: Promise.all of two consumeAuthorizationState calls on the SAME state — exactly one wins", async () => {
    const state = await issueState();
    const token = signStateToken(state.stateId, tenant);

    const results = await Promise.allSettled([
      consumeAuthorizationState(token, { ...EXPECT, principalUserId: user }),
      consumeAuthorizationState(token, { ...EXPECT, principalUserId: user }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "google_oauth_invalid_state",
      detail: { reason: "unknown_or_expired" },
    });

    // And the DB agrees there is exactly one consumed row, not a double-write or a lost update.
    const row = await withTenants(
      [tenant],
      (c) => c.query<{ consumed_at: string | null }>(
        `SELECT consumed_at FROM search_google_oauth_states WHERE id = $1`,
        [state.stateId],
      ),
      { modules: ["search"] },
    );
    expect(row.rows[0].consumed_at).not.toBeNull();
  });

  // Higher-concurrency variant: five simultaneous racers, still exactly one winner.
  it("2d · CONCURRENT RACE (x5): five simultaneous consumes on one state — still exactly one winner", async () => {
    const state = await issueState();
    const token = signStateToken(state.stateId, tenant);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => consumeAuthorizationState(token, { ...EXPECT, principalUserId: user })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(4);
  });

  // ── 2f · expired state, backdated directly in the DB ──────────────────────────────────────────────

  it("2f · EXPIRED: a state whose expires_at is backdated in the DB is refused, indistinguishable from unknown", async () => {
    const state = await issueState();
    const token = signStateToken(state.stateId, tenant);

    await withTenants(
      [tenant],
      (c) => c.query(`UPDATE search_google_oauth_states SET expires_at = now() - interval '1 hour' WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );

    await expect(
      consumeAuthorizationState(token, { ...EXPECT, principalUserId: user }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state", detail: { reason: "unknown_or_expired" } });

    // And it is NOT merely "expired but still consumable once" — confirm the row is still unconsumed
    // (expiry refusal must not itself burn the single-use property) yet still refuses on a second try,
    // because it is still expired.
    await expect(
      consumeAuthorizationState(token, { ...EXPECT, principalUserId: user }),
    ).rejects.toMatchObject({ code: "google_oauth_invalid_state", detail: { reason: "unknown_or_expired" } });
  });

  // ── 5 · FORCE-RLS foreclosure over the REAL runtime role, targeted read by id (not just COUNT) ───

  it("5 · RLS FORECLOSURE: connecting as platform_app_test for tenant B cannot read tenant A's row BY ID", async () => {
    const state = await issueState(tenant);

    // Confirm we are actually running as the non-superuser runtime role this file's persistence
    // depends on (the exact role testing/setup.ts provisions: NOSUPERUSER NOBYPASSRLS). If this ever
    // silently became a superuser connection, RLS would be bypassed and every isolation assertion in
    // this suite (and the sandbox suite's A7) would be a false PASS.
    const roleCheck = await withTenants(
      [otherTenant],
      (c) => c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT r.rolname, r.rolsuper, r.rolbypassrls
           FROM pg_roles r WHERE r.rolname = current_user`,
      ),
      { modules: ["search"] },
    );
    expect(roleCheck.rows[0].rolsuper).toBe(false);
    expect(roleCheck.rows[0].rolbypassrls).toBe(false);

    // Targeted read BY THE EXACT ROW ID (not COUNT(*)) from a session whose GUC only ever named
    // otherTenant. If RLS were merely an app-level WHERE clause somewhere else, a raw SELECT by primary
    // key with no app-level filter at all would still return the row when RLS is what's actually
    // supposed to foreclose it — this query has NO WHERE clause on tenant_id, proving the foreclosure is
    // the POLICY, not incidental app code.
    const targeted = await withTenants(
      [otherTenant],
      (c) => c.query<{ id: string }>(`SELECT id FROM search_google_oauth_states WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );
    expect(targeted.rows).toEqual([]);

    // And an attempted WRITE (the UPDATE the callback itself uses) from tenant B against tenant A's row
    // must also match zero rows — not merely "the read is filtered", the WRITE path is foreclosed too.
    const writeAttempt = await withTenants(
      [otherTenant],
      (c) => c.query(`UPDATE search_google_oauth_states SET consumed_at = now() WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );
    expect(writeAttempt.rowCount).toBe(0);

    // Sanity: the row genuinely exists (proves the zero-row result above is RLS foreclosure, not the
    // row having failed to insert at all).
    const asOwner = await withTenants(
      [tenant],
      (c) => c.query<{ id: string }>(`SELECT id FROM search_google_oauth_states WHERE id = $1`, [state.stateId]),
      { modules: ["search"] },
    );
    expect(asOwner.rows.length).toBe(1);
  });

  it("5b · a raw connection with NO tenant GUC set at all (app_current_tenants() empty) reads zero rows, never all rows", async () => {
    await issueState(tenant);
    // withTenants([]) still runs as platform_app_test but sets no tenant in the GUC — the fail-closed
    // floor: app_current_tenants() empty means the USING clause's ANY(...) can never be true.
    const rows = await withTenants(
      [],
      (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_google_oauth_states`),
      { modules: ["search"] },
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});
