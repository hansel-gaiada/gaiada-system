// SM-51 — harness-shape + protocol-strictness proofs for the GOOGLE sandbox, driven by BARE `fetch`
// with no platform code in the loop at all (tracker §6x.3 AC: "the token machine issues/refreshes/
// rotates/revokes with state a bare-fetch test drives end-to-end").
//
// WHY BARE FETCH AND NO DATABASE: this file's subject is the HARNESS, not our client. Driving it with
// raw HTTP means a failure here can only be the sandbox's own fault — there is no client to blame — and
// it keeps these assertions runnable without Postgres, so they never skip silently when
// DATABASE_URL_TEST is unset. The full-chain proofs (vault, RLS, refresh-on-401 through our real client)
// live in src/modules/search/google/google-oauth.sandbox.test.ts, which DOES need Postgres.
//
// REMINDER, BINDING (§A12.5): nothing in this file proves a GOOGLE fact. Every assertion below is about
// OUR OWN MODEL of an OAuth issuer and of three Google APIs. A green run here is a validated harness,
// not a validated integration. Google's consent screen, its scope-grant semantics, Testing-mode's
// 7-day refresh-token expiry, Google-side revocation, quota/429 behaviour and the Ads developer-token /
// MCC semantics are all SM-41G, and no test name in this file may suggest otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";

import {
  startGoogleSandbox,
  GOOGLE_SANDBOX_DENY_SCOPE_MARKER,
  GOOGLE_SANDBOX_QUOTA_MARKER,
  type GoogleSandbox,
} from "./google-server";

const CLIENT_ID = "sm51-google-dev-client";
const CLIENT_SECRET = "sm51-google-dev-secret";
const REDIRECT_URI = "http://127.0.0.1:3004/api/search/google/oauth/callback";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

describe("SM-51 · google sandbox harness shape (ephemeral port, per-instance state, clean teardown)", () => {
  let sb: GoogleSandbox;
  beforeAll(async () => {
    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
  });
  afterAll(async () => {
    await sb.close();
  });

  it("listens on 127.0.0.1 at a real, non-zero ephemeral port (§A10.2: no fixed port, no compose form)", () => {
    expect(sb.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(new URL(sb.origin).port)).toBeGreaterThan(0);
  });

  it("exposes config-shaped endpoint seams that all point at its own origin", () => {
    for (const url of Object.values(sb.endpoints)) expect(url.startsWith(sb.origin)).toBe(true);
    expect(sb.endpoints.tokenUrl).toBe(`${sb.origin}/token`);
  });

  it("an unknown path gets a real Google-shaped 404, not a connection refusal and not a near-miss fixture", async () => {
    const res = await fetch(`${sb.origin}/definitely-not-a-google-path`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { status: string } };
    expect(body.error.status).toBe("NOT_FOUND");
  });

  it("state is PER INSTANCE — a second sandbox does not see the first one's issued tokens", async () => {
    const other = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    try {
      expect(other.issuedAccessTokenCount()).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("SM-51 · the stateful token machine, driven end to end by bare fetch", () => {
  let sb: GoogleSandbox;
  beforeAll(async () => {
    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
  });
  afterAll(async () => {
    await sb.close();
  });

  /** Walk the authorize redirect and return the issued code. `redirect: "manual"` so we read Location
   *  ourselves, exactly as a browser would be redirected — the sandbox serves no HTML at all. */
  async function authorizeForCode(challenge: string, scope = SCOPE, state = "opaque-state"): Promise<string> {
    const url = new URL(sb.endpoints.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await fetch(url.toString(), { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe(state);
    return loc.searchParams.get("code")!;
  }

  it("authorize → code → token issues an access token AND a refresh token", async () => {
    const { verifier, challenge } = pkce();
    const code = await authorizeForCode(challenge);
    const res = await fetch(
      sb.endpoints.tokenUrl,
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
    expect(body.access_token).toMatch(/^sm51-at-/);
    expect(body.refresh_token).toMatch(/^sm51-rt-/);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe(SCOPE);
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("REFRESH ROTATES: the new refresh token works and the OLD one is dead (the rotation-persistence trap)", async () => {
    const { verifier, challenge } = pkce();
    const code = await authorizeForCode(challenge);
    const first = (await (
      await fetch(sb.endpoints.tokenUrl, form({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      }))
    ).json()) as { refresh_token: string };

    const refreshed = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    }));
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token?: string };
    expect(second.access_token).toMatch(/^sm51-at-/);
    expect(second.refresh_token).toBeDefined();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The machine's own view agrees with the wire: old dead, new live.
    expect(sb.isRefreshTokenLive(first.refresh_token)).toBe(false);
    expect(sb.isRefreshTokenLive(second.refresh_token!)).toBe(true);

    // And re-presenting the SUPERSEDED refresh token is refused — which is what breaks a client that
    // fails to persist the rotation.
    const reuse = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    }));
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("a NON-rotating issuer is also modellable — because whether Google rotates is an SM-41G fact, not an assumption", async () => {
    const nonRotating = await startGoogleSandbox({
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, rotateRefreshTokens: false,
    });
    try {
      const { verifier, challenge } = pkce();
      const url = new URL(nonRotating.endpoints.authorizeUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("scope", SCOPE);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      const authRes = await fetch(url.toString(), { redirect: "manual" });
      const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
      const first = (await (
        await fetch(nonRotating.endpoints.tokenUrl, form({
          grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        }))
      ).json()) as { refresh_token: string };
      const second = (await (
        await fetch(nonRotating.endpoints.tokenUrl, form({
          grant_type: "refresh_token", refresh_token: first.refresh_token,
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        }))
      ).json()) as { access_token: string; refresh_token?: string };
      // No rotation: no new refresh token, and the original stays usable.
      expect(second.refresh_token).toBeUndefined();
      expect(second.access_token).toMatch(/^sm51-at-/);
      expect(nonRotating.isRefreshTokenLive(first.refresh_token)).toBe(true);
    } finally {
      await nonRotating.close();
    }
  });

  it("REVOKE (RFC 7009) kills the grant: the refresh token stops working and the access token 401s", async () => {
    const { verifier, challenge } = pkce();
    const code = await authorizeForCode(challenge);
    const tok = (await (
      await fetch(sb.endpoints.tokenUrl, form({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      }))
    ).json()) as { access_token: string; refresh_token: string };

    const rev = await fetch(sb.endpoints.revokeUrl, form({ token: tok.refresh_token }));
    expect(rev.status).toBe(200);
    expect(await rev.text()).toBe(""); // empty body on success, as Google documents

    expect(sb.isRefreshTokenLive(tok.refresh_token)).toBe(false);
    const afterRefresh = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    }));
    expect(afterRefresh.status).toBe(400);

    // Revoking the refresh token ended the GRANT, so the outstanding access token is dead too. This
    // mirrors what Google DOCUMENTS; SM-41G is where it gets observed.
    const apiRes = await fetch(`${sb.endpoints.searchConsoleBaseUrl}/webmasters/v3/sites`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    expect(apiRes.status).toBe(401);
  });

  it("revoking an UNKNOWN token answers 400 invalid_token (Google's documented shape, not the RFC's 200)", async () => {
    const res = await fetch(sb.endpoints.revokeUrl, form({ token: "sm51-rt-never-issued" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });
});

describe("SM-51 · strictness over mocks: the machine refuses what a lenient mock would serve", () => {
  let sb: GoogleSandbox;
  beforeAll(async () => {
    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
  });
  afterAll(async () => {
    await sb.close();
  });

  async function authorize(params: Record<string, string>): Promise<Response> {
    const url = new URL(sb.endpoints.authorizeUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url.toString(), { redirect: "manual" });
  }

  it("authorize refuses an UNREGISTERED redirect_uri outright — it never redirects to it (open-redirect defence)", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: "http://attacker.test/steal",
      scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("authorize REQUIRES PKCE with S256 — a client that silently dropped it fails here, not in staging", async () => {
    const noPkce = await authorize({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
    });
    expect(noPkce.status).toBe(400);

    const { challenge } = pkce();
    const plainMethod = await authorize({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: "plain",
    });
    expect(plainMethod.status).toBe(400);
  });

  it("authorize refuses an unknown client_id", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code", client_id: "not-our-client", redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized_client");
  });

  it("a denied authorization comes back as an error REDIRECT (RFC 6749 §4.1.2.1), not a 400", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: `${SCOPE} ${GOOGLE_SANDBOX_DENY_SCOPE_MARKER}`, state: "s1",
      code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("the token endpoint enforces CLIENT AUTHENTICATION (wrong secret ⇒ 401 invalid_client)", async () => {
    const { verifier, challenge } = pkce();
    const url = new URL(sb.endpoints.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: "S256",
    })) url.searchParams.set(k, v);
    const code = new URL((await fetch(url.toString(), { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;

    const res = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
      client_id: CLIENT_ID, client_secret: "wrong-secret",
    }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    expect(sb.hitCount("google:token_auth_refused")).toBeGreaterThan(0);
  });

  it("the token endpoint VERIFIES the PKCE verifier (a wrong verifier is refused, not merely a missing one)", async () => {
    const { challenge } = pkce();
    const url = new URL(sb.endpoints.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: "S256",
    })) url.searchParams.set(k, v);
    const code = new URL((await fetch(url.toString(), { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;

    const wrong = pkce().verifier; // a well-formed verifier for a DIFFERENT challenge
    const res = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: wrong,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(sb.hitCount("google:token_pkce_mismatch_refused")).toBeGreaterThan(0);
  });

  it("an authorization code is SINGLE USE (replay refused at the issuer as well as at our state row)", async () => {
    const { verifier, challenge } = pkce();
    const url = new URL(sb.endpoints.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
      code_challenge: challenge, code_challenge_method: "S256",
    })) url.searchParams.set(k, v);
    const code = new URL((await fetch(url.toString(), { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
    const body = form({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    expect((await fetch(sb.endpoints.tokenUrl, body)).status).toBe(200);
    const second = await fetch(sb.endpoints.tokenUrl, form({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    }));
    expect(second.status).toBe(400);
    expect(sb.hitCount("google:token_code_replay_refused")).toBeGreaterThan(0);
  });

  it("the token endpoint requires form encoding and POST", async () => {
    const asJson = await fetch(sb.endpoints.tokenUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(asJson.status).toBe(400);
    expect((await fetch(sb.endpoints.tokenUrl)).status).toBe(405);
  });
});

describe("SM-51 · the three data surfaces (auth strictness + required fields + Google-shaped envelopes)", () => {
  let sb: GoogleSandbox;
  let accessToken: string;

  beforeAll(async () => {
    sb = await startGoogleSandbox({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    const { verifier, challenge } = pkce();
    const url = new URL(sb.endpoints.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/adwords",
      code_challenge: challenge, code_challenge_method: "S256",
    })) url.searchParams.set(k, v);
    const code = new URL((await fetch(url.toString(), { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
    const tok = (await (
      await fetch(sb.endpoints.tokenUrl, form({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      }))
    ).json()) as { access_token: string };
    accessToken = tok.access_token;
  });
  afterAll(async () => {
    await sb.close();
  });

  const auth = () => ({ authorization: `Bearer ${accessToken}` });

  it("EVERY surface requires a live Bearer this machine issued — a fabricated token 401s", async () => {
    const paths: Array<[string, RequestInit]> = [
      ["/webmasters/v3/sites", { method: "GET" }],
      [
        `/webmasters/v3/sites/${encodeURIComponent("https://sandbox-client.example/")}/searchAnalytics/query`,
        { method: "POST", body: JSON.stringify({ startDate: "2026-07-01", endDate: "2026-07-29" }), headers: { "content-type": "application/json" } },
      ],
      ["/v1beta/properties/123456:runReport", { method: "POST", body: JSON.stringify({ dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-29" }] }), headers: { "content-type": "application/json" } }],
      ["/v18/customers/1234567890/googleAds:search", { method: "POST", body: JSON.stringify({ query: "SELECT campaign.id FROM campaign" }), headers: { "content-type": "application/json" } }],
    ];
    for (const [path, init] of paths) {
      const res = await fetch(`${sb.origin}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: "Bearer sm51-at-fabricated" },
      });
      expect(res.status, `${path} must 401 on a token this machine never issued`).toBe(401);
      const body = (await res.json()) as { error: { status: string } };
      expect(body.error.status).toBe("UNAUTHENTICATED");
    }
  });

  it("Search Console sites.list returns the documented {siteEntry:[…]} envelope incl. an UNVERIFIED-permission site", async () => {
    const res = await fetch(`${sb.origin}/webmasters/v3/sites`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { siteEntry: Array<{ siteUrl: string; permissionLevel: string }> };
    expect(body.siteEntry.length).toBeGreaterThanOrEqual(3);
    // The operationally important case: a site the account can SEE but not query.
    expect(body.siteEntry.some((s) => s.permissionLevel === "siteUnverifiedUser")).toBe(true);
    // Both property FORMS are present, because they percent-encode differently into the query path.
    expect(body.siteEntry.some((s) => s.siteUrl.startsWith("sc-domain:"))).toBe(true);
  });

  it("Search Console searchAnalytics.query REFUSES a request with no date range (400 INVALID_ARGUMENT, not a fixture)", async () => {
    const res = await fetch(
      `${sb.origin}/webmasters/v3/sites/${encodeURIComponent("https://sandbox-client.example/")}/searchAnalytics/query`,
      { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ dimensions: ["query"] }) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { status: string } }).error.status).toBe("INVALID_ARGUMENT");
    expect(sb.hitCount("gsc:search_analytics_missing_dates")).toBe(1);
  });

  it("Search Console searchAnalytics.query returns positional `keys` with ctr as a FRACTION (the classic mis-read)", async () => {
    const res = await fetch(
      `${sb.origin}/webmasters/v3/sites/${encodeURIComponent("https://sandbox-client.example/")}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ startDate: "2026-07-01", endDate: "2026-07-29", dimensions: ["query"], rowLimit: 10 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) {
      expect(Array.isArray(r.keys)).toBe(true);
      expect(r.ctr).toBeGreaterThan(0);
      expect(r.ctr).toBeLessThanOrEqual(1); // a FRACTION, never a percentage
      expect(r.position).toBeGreaterThanOrEqual(1);
    }
  });

  it("Search Console: a site outside the grant is 403, and `rows` is ABSENT (not []) when seeded empty", async () => {
    const forbidden = await fetch(
      `${sb.origin}/webmasters/v3/sites/${encodeURIComponent("https://not-in-the-grant.example/")}/searchAnalytics/query`,
      { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ startDate: "2026-07-01", endDate: "2026-07-29" }) },
    );
    expect(forbidden.status).toBe(403);

    sb.seedSearchAnalytics("https://sandbox-client.example/", null);
    const empty = await fetch(
      `${sb.origin}/webmasters/v3/sites/${encodeURIComponent("https://sandbox-client.example/")}/searchAnalytics/query`,
      { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ startDate: "2026-07-01", endDate: "2026-07-29" }) },
    );
    const body = (await empty.json()) as Record<string, unknown>;
    expect("rows" in body).toBe(false);
    expect(body.responseAggregationType).toBeDefined();
    sb.seedSearchAnalytics("https://sandbox-client.example/", undefined as never); // restore default
  });

  it("GA4 runReport requires dateRanges and returns metric values as STRINGS", async () => {
    const missing = await fetch(`${sb.origin}/v1beta/properties/424242:runReport`, {
      method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ metrics: [{ name: "sessions" }] }),
    });
    expect(missing.status).toBe(400);

    const ok = await fetch(`${sb.origin}/v1beta/properties/424242:runReport`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-29" }], dimensions: [{ name: "sessionSource" }], metrics: [{ name: "sessions" }] }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rows: Array<{ metricValues: Array<{ value: string }> }>; rowCount: number };
    expect(body.rowCount).toBeGreaterThan(0);
    for (const r of body.rows) for (const m of r.metricValues) expect(typeof m.value).toBe("string");
  });

  it("Google Ads search requires a GAQL query and returns cost in MICROS as a string", async () => {
    const missing = await fetch(`${sb.origin}/v18/customers/1234567890/googleAds:search`, {
      method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const ok = await fetch(`${sb.origin}/v18/customers/1234567890/googleAds:search`, {
      method: "POST", headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ query: "SELECT campaign.id, metrics.cost_micros FROM campaign" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { results: Array<{ metrics: { cost_micros: string } }>; fieldMask: string };
    expect(body.results.length).toBeGreaterThan(0);
    expect(typeof body.results[0].metrics.cost_micros).toBe("string");
    expect(body.fieldMask).toContain("metrics.cost_micros");
  });

  it("the Ads MUTATE envelope is served for SM-26's code — and SM-25a's own client refuses to send one", async () => {
    // SM-26 (§6bp Ruling 6) replaced SM-51's fixed single-result stub with one result per operation,
    // and made an empty `operations` a 400 the way the real API does — so this now sends a real
    // one-operation batch. Empty-operations rejection is covered by its own SM-26 case.
    const res = await fetch(`${sb.origin}/v18/customers/1234567890/campaigns:mutate`, {
      method: "POST", headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ operations: [{ update: { resourceName: "customers/1234567890/campaigns/1" } }] }),
    });
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { results: Array<{ resourceName: string }> }).results;
    expect(results).toHaveLength(1); // one result per operation, in order
    expect(results[0].resourceName).toContain("/campaigns/");
    // …and structurally unreachable from this ticket's client: see api-client.ts's assertReadOnlyPath,
    // pinned in google-api-client.sandbox.test.ts. Ads writes stay under SM-21 + WS4 (§A12.1/D-8).
  });

  it("a quota-marked subject answers 429 with Retry-After — modelled from docs, NOT observed Google behaviour", async () => {
    const res = await fetch(`${sb.origin}/v1beta/properties/${GOOGLE_SANDBOX_QUOTA_MARKER}:runReport`, {
      method: "POST", headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: "2026-07-01", endDate: "2026-07-29" }] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(((await res.json()) as { error: { status: string } }).error.status).toBe("RESOURCE_EXHAUSTED");
  });

  it("expireAccessTokens() produces exactly the 401 state that drives refresh-on-401", async () => {
    const killed = sb.expireAccessTokens();
    expect(killed).toBeGreaterThan(0);
    const res = await fetch(`${sb.origin}/webmasters/v3/sites`, { headers: auth() });
    expect(res.status).toBe(401);
  });
});
