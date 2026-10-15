// DW-7h (FRONTEND-BFF-CONTRACT §52.3 to §52.5) — the request hook over the REAL HTTP surface (Postgres + RLS + Cerbos;
// the Linux gate; skips without DATABASE_URL_TEST / CERBOS_URL, and a skipped run proves nothing). Sessions are real
// OIDC bearer tokens signed by an in-test key (the oidc.test.ts seam), each carrying a Keycloak-style `sid` and an `iat`,
// so the cut-off is exercised exactly as live would. The route is `GET /api/:t/notifications`, which any member reads.
//
// What it pins:
//   * a signed-out sid gets 401 `session_revoked`, and the same user's other session does not;
//   * "Block login" (session_id NULL) cuts a token issued before it and not one issued after; the dev-header path,
//     which carries no iat, is not cut by it;
//   * a blocked address on a tenant route gets 403 `ip_blocked` and counts a hit; the same address on another company
//     passes; a lifted or expired block blocks nothing;
//   * a request through nginx (X-Real-IP / X-Forwarded-For) cannot claim an address with `x-gaiada-client-ip`, either
//     to dodge a block or to plant a connection row;
//   * a passing request records its connection with the forwarded address and browser, and a refused one does not.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { config } from "../../config";
import { withGlobal, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setJwksForTest } from "../../auth/oidc";
import { resetRequestSecurityForTest, IP_BLOCKED_MESSAGE, SESSION_REVOKED_MESSAGE } from "./request-guard";

const ready = !!TEST_URL && !!process.env.CERBOS_URL;
const SVC = "svc-token-dw7h1";
const BLOCKED_IP = "203.0.113.66";
const UA = "DW7h-Test-Browser/1.0";

let privateKey: CryptoKey;
async function token(claims: Record<string, unknown>, iat?: number): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.oidcIssuer)
    .setAudience(config.oidcAudience)
    .setIssuedAt(iat)
    .setSubject(String(claims.sub))
    .setExpirationTime("1h")
    .sign(privateKey);
}

/** The connection row is written fire-and-forget, after the response; wait for it rather than race it. */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  return v;
}

describe.skipIf(!ready)("DW-7h request hook: session cut-off, IP blocks, connection record", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let other: string;
  let alice: string; // signed out by sid
  let bob: string;   // login blocked
  let carol: string; // clean, used for the address cases
  const origAuthMode = config.authMode;
  const origToken = config.serviceToken;
  const now = () => Math.floor(Date.now() / 1000);

  const claimsOf = (who: string) => ({ sub: `kc-dw7h-${who}`, email: `${who}@dw7h.test`, email_verified: true, name: who });
  const inbox = (t: string, tok: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/${t}/notifications`, headers: { authorization: `Bearer ${tok}`, ...headers } });
  const seen = (t: string, userId: string) =>
    withTenants([t], (c) =>
      c.query<{ session_id: string; ip: string | null; user_agent: string | null; request_count: string }>(
        `SELECT session_id, host(ip) AS ip, user_agent, request_count::text FROM security_access_seen
          WHERE tenant_id = $1 AND user_id = $2 ORDER BY first_seen_at`,
        [t, userId],
      ),
    ).then((r) => r.rows);
  const block = (t: string, ip: string, extra = "") =>
    withTenants([t], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO security_ip_blocks (tenant_id, ip, reason, created_by, expires_at${extra ? ", lifted_at" : ""})
         VALUES ($1, $2, 'DW-7h test block', $3, now() + interval '1 day'${extra ? `, ${extra}` : ""}) RETURNING id`,
        [t, ip, carol],
      ),
    ).then((r) => r.rows[0].id);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = SVC;
    config.authMode = "hybrid"; // OIDC bearer tokens AND the dev header, so both paths can be driven
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.kid = "dw7h1";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));

    tenant = await createCompany("DW-7h Security Co");
    other = await createCompany("DW-7h Other Co");
    const member = await createRole("member");
    alice = await createUser("alice@dw7h.test", "alice");
    bob = await createUser("bob@dw7h.test", "bob");
    carol = await createUser("carol@dw7h.test", "carol");
    for (const u of [alice, bob, carol]) {
      await addMembership(tenant, u);
      await grantRole(u, member, "company", tenant);
    }
    await addMembership(other, carol);
    await grantRole(carol, member, "company", other);

    app = await buildApp();
    vi.spyOn(console, "error").mockImplementation(() => {}); // `[oidc:amr-claim-missing]` on every live-shaped token
  }, 180_000);

  beforeEach(() => resetRequestSecurityForTest());

  afterAll(async () => {
    config.authMode = origAuthMode;
    config.serviceToken = origToken;
    vi.restoreAllMocks();
    await app?.close();
    await teardownTestDb();
  });

  it("refuses a session IT signed out with 401 session_revoked, and leaves the user's other session alone", async () => {
    const signedOut = await token({ ...claimsOf("alice"), sid: "sess-alice-out" });
    const stillIn = await token({ ...claimsOf("alice"), sid: "sess-alice-in" });
    expect((await inbox(tenant, signedOut)).statusCode).toBe(200);

    await withGlobal((c) =>
      c.query(
        `INSERT INTO security_session_revocations (user_id, session_id, revoked_from_company_id, expires_at)
         VALUES ($1, 'sess-alice-out', $2, now() + interval '13 hours')`,
        [alice, tenant],
      ),
    );
    resetRequestSecurityForTest();

    const refused = await inbox(tenant, signedOut);
    expect(refused.statusCode, refused.body).toBe(401);
    expect(refused.json()).toEqual({ error: SESSION_REVOKED_MESSAGE, reason: "session_revoked" });
    // Not a tenant route either: the cut-off applies to every authenticated request.
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${signedOut}` } })).statusCode).toBe(401);
    expect((await inbox(tenant, stillIn)).statusCode).toBe(200);
  });

  it("ignores a revocation past its expires_at", async () => {
    const tok = await token({ ...claimsOf("alice"), sid: "sess-alice-old" });
    await withGlobal((c) =>
      c.query(
        `INSERT INTO security_session_revocations (user_id, session_id, revoked_at, expires_at)
         VALUES ($1, 'sess-alice-old', now() - interval '2 days', now() - interval '1 day')`,
        [alice],
      ),
    );
    resetRequestSecurityForTest();
    expect((await inbox(tenant, tok)).statusCode).toBe(200);
  });

  it("'Block login' cuts a token issued before it and not one issued after; the dev header has no iat to cut", async () => {
    const before = await token({ ...claimsOf("bob"), sid: "sess-bob-1" }, now() - 300);
    const after = await token({ ...claimsOf("bob"), sid: "sess-bob-2" }, now());
    await withGlobal((c) =>
      c.query(
        `INSERT INTO security_session_revocations (user_id, session_id, revoked_at, revoked_from_company_id, expires_at)
         VALUES ($1, NULL, now() - interval '1 minute', $2, now() + interval '13 hours')`,
        [bob, tenant],
      ),
    );
    resetRequestSecurityForTest();

    const cut = await inbox(tenant, before);
    expect(cut.statusCode, cut.body).toBe(401);
    expect(cut.json().reason).toBe("session_revoked");
    expect((await inbox(tenant, after)).statusCode).toBe(200);
    const dev = await app.inject({ method: "GET", url: `/api/${tenant}/notifications`, headers: { authorization: `Bearer ${SVC}`, "x-user-id": bob } });
    expect(dev.statusCode, dev.body).toBe(200);
  });

  it("refuses a blocked address on that company with 403 ip_blocked and counts the hit; another company lets it in", async () => {
    const tok = await token({ ...claimsOf("carol"), sid: "sess-carol-1" });
    const blockId = await block(tenant, BLOCKED_IP);
    resetRequestSecurityForTest();

    const refused = await inbox(tenant, tok, { "x-gaiada-client-ip": BLOCKED_IP, "x-gaiada-client-ua": UA });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual({ error: IP_BLOCKED_MESSAGE, reason: "ip_blocked" });
    const hits = await eventually(
      () => withTenants([tenant], (c) => c.query<{ hit_count: string; last_hit_at: Date | null }>(
        `SELECT hit_count::text, last_hit_at FROM security_ip_blocks WHERE id = $1`, [blockId])).then((r) => r.rows[0]),
      (r) => r.hit_count !== "0",
    );
    expect(hits.hit_count).toBe("1");
    expect(hits.last_hit_at).not.toBeNull();

    expect((await inbox(other, tok, { "x-gaiada-client-ip": BLOCKED_IP })).statusCode).toBe(200);
    // A refused request is not a connection.
    const rows = await seen(tenant, carol);
    expect(rows.filter((r) => r.ip === BLOCKED_IP)).toEqual([]);
  });

  it("a lifted or expired block blocks nothing", async () => {
    const tok = await token({ ...claimsOf("carol"), sid: "sess-carol-2" });
    await block(tenant, "203.0.113.67", "now()");
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO security_ip_blocks (tenant_id, ip, reason, created_by, created_at, expires_at)
         VALUES ($1, '203.0.113.68', 'DW-7h expired block', $2, now() - interval '2 days', now() - interval '1 day')`,
        [tenant, carol],
      ),
    );
    resetRequestSecurityForTest();
    expect((await inbox(tenant, tok, { "x-gaiada-client-ip": "203.0.113.67" })).statusCode).toBe(200);
    expect((await inbox(tenant, tok, { "x-gaiada-client-ip": "203.0.113.68" })).statusCode).toBe(200);
  });

  it("records a passing request's connection with the forwarded address and browser, once per key", async () => {
    const tok = await token({ ...claimsOf("carol"), sid: "sess-carol-rec" });
    const headers = { "x-gaiada-client-ip": "198.51.100.7", "x-gaiada-client-ua": UA };
    expect((await inbox(tenant, tok, headers)).statusCode).toBe(200);
    expect((await inbox(tenant, tok, headers)).statusCode).toBe(200); // throttled: no second write within 60 s
    const rows = await eventually(() => seen(tenant, carol), (r) => r.some((x) => x.session_id === "sess-carol-rec"));
    const mine = rows.filter((r) => r.session_id === "sess-carol-rec");
    expect(mine).toEqual([{ session_id: "sess-carol-rec", ip: "198.51.100.7", user_agent: UA, request_count: "1" }]);
  });

  it("a request through nginx cannot claim an address with x-gaiada-client-ip, to dodge a block or to plant a row", async () => {
    const tok = await token({ ...claimsOf("carol"), sid: "sess-carol-nginx" });
    await block(tenant, "203.0.113.69");
    resetRequestSecurityForTest();

    // Blocked by nginx's address; the claimed clean address changes nothing.
    const dodge = await inbox(tenant, tok, { "x-forwarded-for": "6.6.6.6, 203.0.113.69", "x-gaiada-client-ip": "198.51.100.8" });
    expect(dodge.statusCode, dodge.body).toBe(403);
    expect(dodge.json().reason).toBe("ip_blocked");

    // Claims the blocked address; nginx's X-Real-IP is clean, so it passes, and the row records nginx's address.
    const plant = await inbox(tenant, tok, { "x-real-ip": "198.51.100.20", "x-gaiada-client-ip": "203.0.113.69", "user-agent": "curl/8" });
    expect(plant.statusCode, plant.body).toBe(200);
    const rows = await eventually(() => seen(tenant, carol), (r) => r.some((x) => x.session_id === "sess-carol-nginx"));
    expect(rows.filter((r) => r.session_id === "sess-carol-nginx").map((r) => [r.ip, r.user_agent])).toEqual([["198.51.100.20", "curl/8"]]);
  });

  it("a route without :tenantId records nothing and checks no block", async () => {
    const tok = await token({ ...claimsOf("carol"), sid: "sess-carol-me" });
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tok}`, "x-gaiada-client-ip": BLOCKED_IP } });
    expect(me.statusCode, me.body).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await seen(tenant, carol)).filter((r) => r.session_id === "sess-carol-me")).toEqual([]);
  });
});
