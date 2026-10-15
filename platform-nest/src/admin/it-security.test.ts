// DW-7h (BFF §52.6, §52.7, §52.8) — the IT security routes and the two changed IT-account actions, driven through the REAL
// HTTP surface (Postgres + FORCE RLS + Cerbos) with Keycloak faked at the `fetch` boundary, exactly like it-accounts.test.ts.
// Written for the Linux CI gate: it self-skips without DATABASE_URL_TEST and CERBOS_URL, and a skipped run proves nothing.
//
// What carries weight here:
//   * the refusals, each with its machine `reason` (revokes_yourself, blocks_yourself, shared_address, already_blocked,
//     not_active), because the UI branches on them;
//   * TENANCY: security_access_seen and security_ip_blocks are FORCE-RLS tables, and another company's IT must neither see
//     nor touch these rows (a withGlobal read would see none, so a leak here would be a withTenants bug);
//   * "off" and "unavailable" are never an empty list (§52.6);
//   * "Block login" cuts what is already issued: a user-level revocation row plus Keycloak's logout (§52.7);
//   * the reset-password credential is TEMPORARY (§52.8).
//
// `revokes_yourself` needs the caller's `sid`, which only an OIDC bearer token carries (the dev header has none), so that
// case signs a real token with an in-test key, the oidc.test.ts seam step-up.test.ts uses. It needs `principal.sessionId`
// from the request hook (BFF §52.3), which lands with 7h-1.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { buildApp } from "../main";
import { config } from "../config";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { resetKeycloakAdminTokenCache } from "../core/keycloak-admin";
import { setJwksForTest } from "../auth/oidc";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string, extra: Record<string, string> = {}) => ({ ...svc, "x-user-id": id, ...extra });

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe.skipIf(!TEST_URL || !live)("DW-7h · IT security over the real surface", () => {
  let app: NestFastifyApplication;
  let T: string; // the company under test
  let T2: string; // another company, with its own IT
  let itAdmin: string;
  let itAdmin2: string;
  let plainMember: string;
  let userA: string; // a member whose sessions IT acts on
  let userB: string;
  let userC: string;
  let privateKey: CryptoKey;
  const realFetch = globalThis.fetch;
  const origAuthMode = config.authMode;
  const origToken = config.serviceToken;

  // One address per call, so tests never share the one-active-block-per-address slot (the tables are not truncated).
  let ipCounter = 10;
  const nextIp = () => `203.0.113.${ipCounter++}`;

  /** What Keycloak does in this test. */
  let kc: {
    calls: Array<{ method: string; url: string; body: unknown }>;
    realm: Map<string, { id: string; enabled: boolean }>;
    eventsConfig: { status: number; eventsEnabled: boolean; types: string[] };
    events: { status: number; rows: Array<Record<string, unknown>> };
    sessionDelete: number; // the status Keycloak answers to DELETE /sessions/{sid}
    logout: number; // ... and to POST /users/{id}/logout
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.authMode = "hybrid"; // the OIDC bearer for the `sid` case AND the dev header for everything else
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.kid = "dw7h";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));
    vi.spyOn(console, "error").mockImplementation(() => {}); // `[oidc:amr-claim-missing]` on a live-shaped token

    T = await createCompany("DW-7h Security Co");
    T2 = await createCompany("DW-7h Other Co");
    const itRole = await createRole("it_admin");
    itAdmin = await createUser("sec.it@dw7h.test", "Sec IT");
    itAdmin2 = await createUser("sec.it2@dw7h.test", "Other IT");
    plainMember = await createUser("sec.plain@dw7h.test", "Plain Member");
    userA = await createUser("sec.a@dw7h.test", "Alice A");
    userB = await createUser("sec.b@dw7h.test", "Bob B");
    userC = await createUser("sec.c@dw7h.test", "Cara C");
    for (const u of [itAdmin, plainMember, userA, userB, userC]) await addMembership(T, u, "employee");
    await addMembership(T2, itAdmin2, "employee");
    await grantRole(itAdmin, itRole, "company", T);
    await grantRole(itAdmin2, itRole, "company", T2);
    // The IdP subjects the sign-in mapping and the OIDC token resolve through (auth/oidc.ts provisionUser).
    await withGlobal(async (c) => {
      await c.query(`UPDATE users SET idp_subject = 'kc-sec-it' WHERE id = $1`, [itAdmin]);
      await c.query(`UPDATE users SET idp_subject = 'kc-sec-a' WHERE id = $1`, [userA]);
      await c.query(`UPDATE users SET idp_subject = 'kc-sec-b' WHERE id = $1`, [userB]);
    });
    app = await buildApp();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    config.authMode = origAuthMode;
    config.serviceToken = origToken;
    vi.restoreAllMocks();
    await app?.close();
    await teardownTestDb();
  });

  function stubKeycloak(): void {
    kc = {
      calls: [], realm: new Map(),
      eventsConfig: { status: 200, eventsEnabled: true, types: ["LOGIN", "LOGIN_ERROR", "LOGOUT"] },
      events: { status: 200, rows: [] }, sessionDelete: 204, logout: 204,
    };
    const stub = vi.fn(async (url: string | URL, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (!u.startsWith("http://kc.test")) return realFetch(url as never, init as never);
      let body: unknown = init?.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* form body */ } }
      kc.calls.push({ method, url: u, body });
      const reply = (status: number, json?: unknown) =>
        ({ ok: status >= 200 && status < 300, status, json: async () => json ?? {}, text: async () => "", headers: { get: () => null } }) as never;

      if (u.includes("/protocol/openid-connect/token")) return reply(200, { access_token: "kc-token", expires_in: 300 });
      if (method === "GET" && u.includes("/events/config")) {
        return reply(kc.eventsConfig.status, { eventsEnabled: kc.eventsConfig.eventsEnabled, enabledEventTypes: kc.eventsConfig.types });
      }
      if (method === "GET" && u.includes("/events?")) return reply(kc.events.status, kc.events.rows);
      if (method === "DELETE" && u.includes("/sessions/")) return reply(kc.sessionDelete);
      if (method === "POST" && u.endsWith("/logout")) return reply(kc.logout);
      if (method === "GET" && u.includes("/users?")) {
        const email = decodeURIComponent(new URL(u).searchParams.get("email") ?? "");
        const found = kc.realm.get(email);
        return reply(200, found ? [{ id: found.id, email, enabled: found.enabled, emailVerified: true }] : []);
      }
      if (method === "PUT") {
        const b = (body ?? {}) as { enabled?: boolean };
        if (typeof b.enabled === "boolean") for (const [email, rec] of kc.realm) if (u.includes(rec.id)) kc.realm.set(email, { ...rec, enabled: b.enabled });
        return reply(204);
      }
      return reply(204);
    });
    vi.stubGlobal("fetch", stub as unknown as typeof fetch);
  }

  beforeEach(() => {
    config.keycloakAdmin = { baseUrl: "http://kc.test", realm: "gaiada", clientId: "prov", clientSecret: "s3cret" };
    resetKeycloakAdminTokenCache();
    stubKeycloak();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  const get = (path: string, headers: Record<string, string>, tenant = T) =>
    app.inject({ method: "GET", url: `/api/${tenant}/it/security/${path}`, headers });
  const post = (path: string, headers: Record<string, string>, payload: Record<string, unknown> = {}, tenant = T) =>
    app.inject({ method: "POST", url: `/api/${tenant}/it/security/${path}`, headers, payload });

  async function seed(
    tenant: string, userId: string, sessionId: string, ip: string | null,
    over: { ua?: string; firstSeenHoursAgo?: number; lastSeenHoursAgo?: number } = {},
  ): Promise<void> {
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO security_access_seen (tenant_id, user_id, session_id, ip, user_agent, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4::inet, $5, now() - make_interval(secs => $6::double precision * 3600), now() - make_interval(secs => $7::double precision * 3600))
         ON CONFLICT ON CONSTRAINT ux_security_access_seen_key DO NOTHING`,
        [tenant, userId, sessionId, ip, over.ua ?? CHROME_WIN, over.firstSeenHoursAgo ?? 1, over.lastSeenHoursAgo ?? 0.5],
      ),
    );
  }

  const activities = (verb: string) =>
    withTenants([T], (c) => c.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM activities WHERE tenant_id = $1 AND verb = $2`, [T, verb]));
  const revocations = (userId: string) =>
    withGlobal((c) =>
      c.query<{ session_id: string | null; revoked_by: string | null; revoked_from_company_id: string | null; reason: string | null; hours: number }>(
        `SELECT session_id, revoked_by, revoked_from_company_id, reason, round(extract(epoch FROM (expires_at - revoked_at)) / 3600)::int AS hours
           FROM security_session_revocations WHERE user_id = $1 ORDER BY revoked_at`,
        [userId],
      ),
    );
  const kcEvent = (minutesAgo: number, over: Record<string, unknown> = {}) => ({
    time: Date.now() - minutesAgo * 60_000, type: "LOGIN", userId: "kc-sec-a", ipAddress: "198.51.100.5",
    details: { username: "sec.a@dw7h.test" }, ...over,
  });

  // ── authorization and tenancy ───────────────────────────────────────────────────────────────────

  it("an IT admin reads all four lists; a plain member is refused on every route", async () => {
    for (const p of ["connections", "sign-ins", "alerts", "blocks"]) {
      expect((await get(p, asUser(itAdmin))).statusCode, p).toBe(200);
      expect((await get(p, asUser(plainMember))).statusCode, p).toBe(403);
    }
    const ip = nextIp();
    expect((await post("blocks", asUser(plainMember), { ip, reason: "plain member" })).statusCode).toBe(403);
    expect((await post(`sessions/s-x/revoke`, asUser(plainMember), { userId: userA })).statusCode).toBe(403);
    expect((await post(`blocks/${newId()}/lift`, asUser(plainMember))).statusCode).toBe(403);
  });

  it("🔴 another company's IT can neither see nor touch this company's rows", async () => {
    const ip = nextIp();
    await seed(T, userA, "s-iso-1", ip);
    const created = await post("blocks", asUser(itAdmin), { ip, reason: "isolation probe" });
    expect(created.statusCode, created.body).toBe(201);
    const blockId = created.json().id as string;

    // IT of T2 asking about T is refused outright...
    for (const p of ["connections", "sign-ins", "alerts", "blocks"]) expect((await get(p, asUser(itAdmin2), T)).statusCode, p).toBe(403);
    expect((await post("blocks", asUser(itAdmin2), { ip: nextIp(), reason: "cross company" }, T)).statusCode).toBe(403);
    // ...and in its OWN company it sees none of T's rows, and cannot reach them by id or by session.
    const own = await get("connections", asUser(itAdmin2), T2);
    expect(own.statusCode).toBe(200);
    expect(own.json().connections).toEqual([]);
    const ownBlocks = (await get("blocks", asUser(itAdmin2), T2)).json();
    expect(ownBlocks.ipBlocks).toEqual([]);
    expect(ownBlocks.revokedSessions).toEqual([]);
    expect((await post(`blocks/${blockId}/lift`, asUser(itAdmin2), {}, T2)).statusCode).toBe(404);
    expect((await post("sessions/s-iso-1/revoke", asUser(itAdmin2), { userId: userA }, T2)).statusCode).toBe(404);
    // The same address is a separate block in the other company.
    expect((await post("blocks", asUser(itAdmin2), { ip, reason: "my own block of it" }, T2)).statusCode).toBe(201);
  });

  // ── connections ─────────────────────────────────────────────────────────────────────────────────

  it("connections: who, address without a mask, parsed device, newest first, window honoured", async () => {
    const ipNew = nextIp();
    const ipOld = nextIp();
    await seed(T, userA, "s-conn-new", ipNew, { ua: SAFARI_IPHONE, lastSeenHoursAgo: 0.1 });
    await seed(T, userB, "s-conn-old", ipOld, { lastSeenHoursAgo: 5 });
    const res = await get("connections?window=24h", asUser(itAdmin));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { window: string; asOf: string; connections: Array<Record<string, any>> };
    expect(body.window).toBe("24h");
    const mine = body.connections.filter((c) => c.sessionId === "s-conn-new" || c.sessionId === "s-conn-old");
    expect(mine.map((c) => c.sessionId)).toEqual(["s-conn-new", "s-conn-old"]);
    expect(mine[0]).toMatchObject({
      who: { userId: userA, displayName: "Alice A", email: "sec.a@dw7h.test" }, ip: ipNew, requestCount: 1,
      device: { browser: "Safari", os: "iOS", kind: "mobile" }, revoked: false, ipBlocked: false,
    });
    // a narrower window drops the older connection
    const narrow = (await get("connections?window=15m", asUser(itAdmin))).json().connections as Array<{ sessionId: string }>;
    expect(narrow.some((c) => c.sessionId === "s-conn-new")).toBe(true);
    expect(narrow.some((c) => c.sessionId === "s-conn-old")).toBe(false);
  });

  it("a bad window is a 400 naming the field, on every route that takes one", async () => {
    for (const p of ["connections", "sign-ins", "alerts"]) {
      const res = await get(`${p}?window=1h`, asUser(itAdmin));
      expect(res.statusCode, p).toBe(400);
      expect(res.json(), p).toMatchObject({ field: "window" });
    }
    // sign-ins take 24h or 7d only
    expect((await get("sign-ins?window=15m", asUser(itAdmin))).statusCode).toBe(400);
    expect((await get("sign-ins?window=7d", asUser(itAdmin))).statusCode).toBe(200);
  });

  // ── sign-ins and alerts ─────────────────────────────────────────────────────────────────────────

  it("sign-ins: events of members only, unknown accounts counted but never named", async () => {
    kc.events.rows = [
      kcEvent(5, { type: "LOGIN_ERROR", error: "invalid_user_credentials" }),
      kcEvent(6, { type: "LOGIN" }),
      kcEvent(7, { type: "LOGIN_ERROR", userId: undefined, error: "user_not_found", details: { username: "stranger@nowhere.test" } }),
      kcEvent(8, { type: "LOGIN_ERROR", userId: "kc-of-t2", details: { username: "sec.it2@dw7h.test" }, error: "invalid_user_credentials" }),
    ];
    const res = await get("sign-ins", asUser(itAdmin));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.state).toBe("on");
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["failed", "sign_in"]);
    expect(body.events[0]).toMatchObject({ userId: userA, email: "sec.a@dw7h.test", ip: "198.51.100.5", error: "invalid_user_credentials" });
    expect(body.summary).toMatchObject({ signIns: 1, failed: 1 });
    // the stranger is counted, never named; the other company's IT account is neither listed nor counted
    expect(body.unknownAccounts).toEqual({ failed: 1 });
    expect(res.body).not.toContain("stranger@nowhere.test");
    expect(res.body).not.toContain("sec.it2@dw7h.test");
  });

  it("🔴 sign-ins are never an empty list when events are OFF or the read is UNAVAILABLE", async () => {
    kc.eventsConfig.eventsEnabled = false;
    const off = (await get("sign-ins", asUser(itAdmin))).json();
    expect(off.state).toBe("off");
    expect(off.events).toEqual([]);

    kc.eventsConfig = { status: 200, eventsEnabled: true, types: ["LOGIN", "LOGIN_ERROR", "LOGOUT"] };
    kc.events.status = 403; // the service account lacks view-events
    const denied = (await get("sign-ins", asUser(itAdmin))).json();
    expect(denied.state).toBe("unavailable");
    expect(denied.reason).toContain("view-events");

    config.keycloakAdmin = { baseUrl: "", realm: "", clientId: "", clientSecret: "" };
    const unconfigured = (await get("sign-ins", asUser(itAdmin))).json();
    expect(unconfigured.state).toBe("unavailable");
    expect(unconfigured.reason).toMatch(/not configured/i);
  });

  it("alerts: 5 failures for one member inside 15 minutes is high; the sign-in state is reported", async () => {
    kc.events.rows = [1, 2, 3, 4, 5].map((m) => kcEvent(m, { type: "LOGIN_ERROR", error: "invalid_user_credentials" }));
    const res = await get("alerts?window=24h", asUser(itAdmin));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.signIns).toBe("on");
    const a = (body.alerts as Array<Record<string, any>>).find((x) => x.kind === "failed_signins_account")!;
    expect(a).toMatchObject({ severity: "high", count: 5, subject: { userId: userA, email: "sec.a@dw7h.test" } });
  });

  it("alerts: 4 failures are no alert, and with sign-ins off the other rules still run", async () => {
    kc.events.rows = [1, 2, 3, 4].map((m) => kcEvent(m, { type: "LOGIN_ERROR", error: "invalid_user_credentials" }));
    expect((await get("alerts", asUser(itAdmin))).json().alerts.some((x: { kind: string }) => x.kind === "failed_signins_account")).toBe(false);

    // a block that has stopped requests, and a member's first connection from a new place
    const ip = nextIp();
    const created = await post("blocks", asUser(itAdmin), { ip, reason: "alert probe" });
    await withTenants([T], (c) => c.query(`UPDATE security_ip_blocks SET hit_count = 3, last_hit_at = now() WHERE id = $1`, [created.json().id]));
    await seed(T, userC, "s-old", "198.51.100.40", { firstSeenHoursAgo: 72, lastSeenHoursAgo: 71 });
    const newIp = nextIp();
    await seed(T, userC, "s-new", newIp, { ua: SAFARI_IPHONE, firstSeenHoursAgo: 0.2, lastSeenHoursAgo: 0.1 });

    kc.eventsConfig.eventsEnabled = false;
    const body = (await get("alerts?window=24h", asUser(itAdmin))).json();
    expect(body.signIns).toBe("off");
    const kinds = (body.alerts as Array<{ kind: string; subject: { ip?: string } }>);
    expect(kinds.some((x) => x.kind === "blocked_ip_hits" && x.subject.ip === ip)).toBe(true);
    expect(kinds.some((x) => x.kind === "new_device" && x.subject.ip === newIp)).toBe(true);
    expect(kinds.some((x) => x.kind === "failed_signins_account" || x.kind === "failed_signins_ip")).toBe(false);
  });

  // ── revoke a session ────────────────────────────────────────────────────────────────────────────

  it("revoke: writes the revocation row (13 h), ends the Keycloak session, audits, and the connection reads revoked", async () => {
    await seed(T, userA, "s-rev-1", nextIp());
    const res = await post("sessions/s-rev-1/revoke", asUser(itAdmin), { userId: userA, reason: "lost laptop" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ revoked: true, keycloak: "ended" });

    expect(kc.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/sessions/s-rev-1"))).toBe(true);
    const rows = (await revocations(userA)).rows.filter((r) => r.session_id === "s-rev-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revoked_by: itAdmin, revoked_from_company_id: T, reason: "lost laptop", hours: 13 });
    expect((await activities("it.security.session_revoke")).rows.some((r) => r.metadata.sessionId === "s-rev-1" && r.metadata.keycloak === "ended")).toBe(true);

    const conns = (await get("connections", asUser(itAdmin))).json().connections as Array<{ sessionId: string; revoked: boolean }>;
    expect(conns.find((c) => c.sessionId === "s-rev-1")!.revoked).toBe(true);
    const listed = (await get("blocks", asUser(itAdmin))).json().revokedSessions as Array<Record<string, any>>;
    expect(listed.find((r) => r.sessionId === "s-rev-1")).toMatchObject({ who: { userId: userA }, reason: "lost laptop", revokedBy: { userId: itAdmin } });
  });

  it("🔴 revoke is still revoked: true when Keycloak fails, and says what Keycloak did", async () => {
    await seed(T, userA, "s-rev-fail", nextIp());
    kc.sessionDelete = 500;
    const failed = await post("sessions/s-rev-fail/revoke", asUser(itAdmin), { userId: userA });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ revoked: true, keycloak: "failed" });
    expect((await revocations(userA)).rows.some((r) => r.session_id === "s-rev-fail")).toBe(true);

    await seed(T, userA, "s-rev-gone", nextIp());
    kc.sessionDelete = 404;
    expect((await post("sessions/s-rev-gone/revoke", asUser(itAdmin), { userId: userA })).json()).toEqual({ revoked: true, keycloak: "not_found" });
  });

  it("revoke: 404 for a session never seen for that person in this company, 400 for a bad userId", async () => {
    await seed(T, userA, "s-rev-a", nextIp());
    const never = await post("sessions/s-never-seen/revoke", asUser(itAdmin), { userId: userA });
    expect(never.statusCode).toBe(404);
    expect(never.json().reason).toBe("session_not_found");
    // a real session, but of another person
    expect((await post("sessions/s-rev-a/revoke", asUser(itAdmin), { userId: userB })).statusCode).toBe(404);
    const bad = await post("sessions/s-rev-a/revoke", asUser(itAdmin), { userId: "not-a-uuid" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ field: "userId" });
    expect(kc.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("🔴 409 revokes_yourself: an IT admin cannot sign out the session they are using", async () => {
    const tok = await new SignJWT({ sub: "kc-sec-it", email: "sec.it@dw7h.test", email_verified: true, name: "Sec IT", sid: "sess-me" })
      .setProtectedHeader({ alg: "RS256", kid: "dw7h" })
      .setIssuer(config.oidcIssuer).setAudience(config.oidcAudience).setIssuedAt().setSubject("kc-sec-it").setExpirationTime("1h")
      .sign(privateKey);
    await seed(T, itAdmin, "sess-me", nextIp());
    const res = await post("sessions/sess-me/revoke", { authorization: `Bearer ${tok}` }, { userId: itAdmin });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().reason).toBe("revokes_yourself");
    expect((await revocations(itAdmin)).rows.some((r) => r.session_id === "sess-me")).toBe(false);
    expect(kc.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  // ── block an address ────────────────────────────────────────────────────────────────────────────

  it("block: 201 with the IpBlock, default 24 hours, audited; listed first on the Blocks page", async () => {
    const ip = nextIp();
    const res = await post("blocks", asUser(itAdmin), { ip, reason: "password spraying" });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({
      ip, reason: "password spraying", active: true, createdBy: { userId: itAdmin, displayName: "Sec IT" },
      liftedAt: null, liftedBy: null, hitCount: 0, lastHitAt: null,
    });
    expect(Math.round((Date.parse(b.expiresAt) - Date.parse(b.createdAt)) / 3_600_000)).toBe(24);
    expect((await activities("it.security.ip_block")).rows.some((r) => r.metadata.ip === ip && r.metadata.hours === 24)).toBe(true);

    const list = (await get("blocks", asUser(itAdmin))).json().ipBlocks as Array<{ id: string; active: boolean }>;
    expect(list.find((x) => x.id === b.id)!.active).toBe(true);
    // the connection from that address now reads ipBlocked
    await seed(T, userB, "s-blk-1", ip);
    const conns = (await get("connections", asUser(itAdmin))).json().connections as Array<{ sessionId: string; ipBlocked: boolean }>;
    expect(conns.find((c) => c.sessionId === "s-blk-1")!.ipBlocked).toBe(true);
    // a longer block
    const long = await post("blocks", asUser(itAdmin), { ip: nextIp(), reason: "a month", hours: 720 });
    expect(Math.round((Date.parse(long.json().expiresAt) - Date.parse(long.json().createdAt)) / 3_600_000)).toBe(720);
  });

  it("block: 400 for an invalid, private, loopback or link-local address, and for bad hours or reason", async () => {
    const bad = async (payload: Record<string, unknown>, field: string, reason?: string) => {
      const res = await post("blocks", asUser(itAdmin), { reason: "probe reason", ...payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json(), JSON.stringify(payload)).toMatchObject({ field, ...(reason ? { reason } : {}) });
    };
    await bad({ ip: "not-an-ip" }, "ip", "invalid");
    await bad({ ip: "203.0.113.0/24" }, "ip", "invalid");
    await bad({}, "ip", "invalid");
    await bad({ ip: "10.1.2.3" }, "ip", "private");
    await bad({ ip: "172.16.5.5" }, "ip", "private");
    await bad({ ip: "192.168.1.1" }, "ip", "private");
    await bad({ ip: "fd00::1" }, "ip", "private");
    await bad({ ip: "127.0.0.1" }, "ip", "loopback");
    await bad({ ip: "::1" }, "ip", "loopback");
    await bad({ ip: "169.254.1.1" }, "ip", "link_local");
    await bad({ ip: "fe80::1" }, "ip", "link_local");
    await bad({ ip: nextIp(), hours: 0 }, "hours");
    await bad({ ip: nextIp(), hours: 721 }, "hours");
    await bad({ ip: nextIp(), hours: 1.5 }, "hours");
    await bad({ ip: nextIp(), hours: "24" }, "hours");
    await bad({ ip: nextIp(), reason: "x" }, "reason");
  });

  it("🔴 409 blocks_yourself: the caller's own address is refused (x-gaiada-client-ip sets it)", async () => {
    const mine = nextIp();
    const res = await post("blocks", asUser(itAdmin, { "x-gaiada-client-ip": mine }), { ip: mine, reason: "oops" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().reason).toBe("blocks_yourself");
    // a different address is fine from the same caller, and a mapped spelling of one's own is still one's own
    expect((await post("blocks", asUser(itAdmin, { "x-gaiada-client-ip": mine }), { ip: nextIp(), reason: "someone else" })).statusCode).toBe(201);
    const res2 = await post("blocks", asUser(itAdmin, { "x-gaiada-client-ip": `::ffff:${mine}` }), { ip: mine, reason: "oops again" });
    expect(res2.statusCode).toBe(409);
  });

  it("🔴 409 shared_address when 3 or more members connected from it in 24 h, unless confirmShared", async () => {
    const shared = nextIp();
    await seed(T, userA, "s-sh-a", shared);
    await seed(T, userB, "s-sh-b", shared);
    // two members: allowed without confirmation
    const two = nextIp();
    await seed(T, userA, "s-two-a", two);
    await seed(T, userB, "s-two-b", two);
    expect((await post("blocks", asUser(itAdmin), { ip: two, reason: "two members" })).statusCode).toBe(201);

    await seed(T, userC, "s-sh-c", shared);
    const refused = await post("blocks", asUser(itAdmin), { ip: shared, reason: "office?" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "shared_address", detail: { users: 3 } });
    expect((await post("blocks", asUser(itAdmin), { ip: shared, reason: "office?", confirmShared: false })).statusCode).toBe(409);
    expect((await post("blocks", asUser(itAdmin), { ip: shared, reason: "confirmed", confirmShared: true })).statusCode).toBe(201);
  });

  it("a connection older than 24 h does not make an address shared", async () => {
    const ip = nextIp();
    for (const [u, s] of [[userA, "s-old-a"], [userB, "s-old-b"], [userC, "s-old-c"]] as const) {
      await seed(T, u, s, ip, { firstSeenHoursAgo: 60, lastSeenHoursAgo: 30 });
    }
    expect((await post("blocks", asUser(itAdmin), { ip, reason: "stale sharing" })).statusCode).toBe(201);
  });

  it("409 already_blocked; an expired block that was never lifted is freed and replaced", async () => {
    const ip = nextIp();
    expect((await post("blocks", asUser(itAdmin), { ip, reason: "first" })).statusCode).toBe(201);
    const dup = await post("blocks", asUser(itAdmin), { ip, reason: "second" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().reason).toBe("already_blocked");

    const stale = nextIp();
    const staleId = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO security_ip_blocks (id, tenant_id, ip, reason, created_by, created_at, expires_at)
         VALUES ($1, $2, $3::inet, 'expired long ago', $4, now() - interval '3 hours', now() - interval '2 hours')`,
        [staleId, T, stale, itAdmin],
      ),
    );
    const fresh = await post("blocks", asUser(itAdmin), { ip: stale, reason: "again" });
    expect(fresh.statusCode, fresh.body).toBe(201);
    const row = await withTenants([T], (c) => c.query<{ lifted_at: Date; expires_at: Date; lifted_by: string | null }>(`SELECT lifted_at, expires_at, lifted_by FROM security_ip_blocks WHERE id = $1`, [staleId]));
    expect(row.rows[0].lifted_at.getTime()).toBe(row.rows[0].expires_at.getTime());
    expect(row.rows[0].lifted_by).toBeNull();
  });

  // ── lift ────────────────────────────────────────────────────────────────────────────────────────

  it("lift: 200 with liftedAt and liftedBy, audited; a second lift is 409 not_active; the address can be blocked again", async () => {
    const ip = nextIp();
    const id = (await post("blocks", asUser(itAdmin), { ip, reason: "to lift" })).json().id as string;
    const lifted = await post(`blocks/${id}/lift`, asUser(itAdmin));
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(lifted.json()).toMatchObject({ id, active: false, liftedBy: { userId: itAdmin } });
    expect(lifted.json().liftedAt).toBeTruthy();
    expect((await activities("it.security.ip_unblock")).rows.some((r) => r.metadata.ip === ip)).toBe(true);

    const again = await post(`blocks/${id}/lift`, asUser(itAdmin));
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe("not_active");
    expect((await post("blocks", asUser(itAdmin), { ip, reason: "blocked again" })).statusCode).toBe(201);
  });

  it("lift: 404 for an unknown block and for something that is not an id; an expired block is not_active", async () => {
    expect((await post(`blocks/${newId()}/lift`, asUser(itAdmin))).statusCode).toBe(404);
    expect((await post("blocks/not-a-uuid/lift", asUser(itAdmin))).statusCode).toBe(404);
    const id = newId();
    await withTenants([T], (c) =>
      c.query(
        `INSERT INTO security_ip_blocks (id, tenant_id, ip, reason, created_by, created_at, expires_at)
         VALUES ($1, $2, $3::inet, 'ran out', $4, now() - interval '3 hours', now() - interval '1 hour')`,
        [id, T, nextIp(), itAdmin],
      ),
    );
    expect((await post(`blocks/${id}/lift`, asUser(itAdmin))).statusCode).toBe(409);
  });

  // ── the changed IT-account actions ──────────────────────────────────────────────────────────────

  it("🔴 disable writes a user-level revocation, calls Keycloak's logout, and answers sessionsEnded", async () => {
    kc.realm.set("sec.b@dw7h.test", { id: "kc-b-id", enabled: true });
    const res = await app.inject({ method: "POST", url: `/api/${T}/it/accounts/${userB}/disable`, headers: asUser(itAdmin), payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyDisabled: false, sessionsEnded: true });

    expect(kc.calls.some((c) => c.method === "POST" && c.url.endsWith("/users/kc-b-id/logout"))).toBe(true);
    const rows = (await revocations(userB)).rows.filter((r) => r.session_id === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revoked_by: itAdmin, revoked_from_company_id: T, hours: 13 });
    expect((await activities("it.account.disable")).rows.some((r) => r.metadata.sessionsEnded === true)).toBe(true);
  });

  it("a Keycloak logout failure after disable is sessionsEnded: false, and the revocation row still cuts the ERP", async () => {
    kc.realm.set("sec.c@dw7h.test", { id: "kc-c-id", enabled: true });
    kc.logout = 500;
    const res = await app.inject({ method: "POST", url: `/api/${T}/it/accounts/${userC}/disable`, headers: asUser(itAdmin), payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, alreadyDisabled: false, sessionsEnded: false });
    expect((await revocations(userC)).rows.filter((r) => r.session_id === null)).toHaveLength(1);
  });

  it("reset-password sets a TEMPORARY password (the person must choose their own at first sign-in)", async () => {
    kc.realm.set("sec.a@dw7h.test", { id: "kc-a-id", enabled: true });
    const res = await app.inject({
      method: "POST", url: `/api/${T}/it/accounts/${userA}/reset-password`, headers: asUser(itAdmin), payload: { reason: "locked out" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const password = res.json().initialPassword as string;
    expect(password.length).toBeGreaterThanOrEqual(12);
    const put = kc.calls.find((c) => c.method === "PUT" && c.url.endsWith("/users/kc-a-id/reset-password"));
    expect(put).toBeTruthy();
    expect(put!.body).toMatchObject({ type: "password", value: password, temporary: true });
  });
});
