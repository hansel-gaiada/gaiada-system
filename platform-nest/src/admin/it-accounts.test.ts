// P2-13 — the IT accounts backend, driven through the REAL HTTP surface with Keycloak stubbed at the
// `fetch` boundary (the same seam `keycloak-admin.test.ts` uses, so this exercises the real admin
// client including its token cache, not a hand-rolled double).
//
// The cases that carry weight here are the DEGRADED and IDEMPOTENT ones. A worklist that quietly
// returns `[]` when it cannot see Keycloak says "everyone has a login" — the most dangerous sentence
// this surface can produce — and a provision that is not idempotent leaves two logins for one address,
// which is an authentication ambiguity rather than a tidiness problem.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withTenants, withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { resetKeycloakAdminTokenCache } from "../core/keycloak-admin";
import { deriveRow, IT_ACCOUNT_ERROR } from "./it-accounts.controller";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const HR = { modules: ["hr"] };

// ── the pure judgement, no app needed ────────────────────────────────────────────────────────────

describe("P2-13 · deriveRow — the worklist's judgement", () => {
  const member = { user_id: "u1", email: "a@ex.com", name: "A" };
  const kc = (over: Partial<{ id: string; enabled: boolean; emailVerified: boolean }> = {}) => ({
    // `username` IS the email in this realm (keycloak-admin.ts's own note), so the fixture mirrors that
    // rather than inventing a second identifier.
    id: "kc-1", username: "a@ex.com", email: "a@ex.com", enabled: true, emailVerified: true, ...over,
  });

  it("no Keycloak account ⇒ missing, and actionable (the joiner case)", () => {
    const row = deriveRow(member, null, undefined, "active");
    expect(row.state).toBe("missing");
    expect(row.actionable).toBe(true);
  });

  it("🔴 a TERMINATED person whose login is still enabled ⇒ leaver_still_enabled, actionable", () => {
    // The finding this worklist exists for.
    const row = deriveRow(member, kc(), { verified_at: new Date() }, "terminated");
    expect(row.state).toBe("leaver_still_enabled");
    expect(row.actionable).toBe(true);
  });

  it("leaver_still_enabled OUTRANKS unverified_link — a security finding beats paperwork", () => {
    const row = deriveRow(member, kc(), { verified_at: null }, "terminated");
    expect(row.state).toBe("leaver_still_enabled");
  });

  it("a terminated person whose login is disabled ⇒ disabled, NOT actionable (this is the done state)", () => {
    const row = deriveRow(member, kc({ enabled: false }), { verified_at: new Date() }, "terminated");
    expect(row.state).toBe("disabled");
    expect(row.actionable).toBe(false);
  });

  it("an ACTIVE person whose login is disabled IS actionable — they cannot work", () => {
    // Why `actionable` is not simply "state !== enabled" with disabled excluded.
    const row = deriveRow(member, kc({ enabled: false }), { verified_at: new Date() }, "active");
    expect(row.state).toBe("disabled");
    expect(row.actionable).toBe(true);
  });

  it("linked but never verified ⇒ unverified_link, actionable", () => {
    const row = deriveRow(member, kc(), { verified_at: null }, "active");
    expect(row.state).toBe("unverified_link");
    expect(row.actionable).toBe(true);
  });

  it("enabled + verified link ⇒ enabled, nothing to do", () => {
    const row = deriveRow(member, kc(), { verified_at: new Date() }, "active");
    expect(row.state).toBe("enabled");
    expect(row.actionable).toBe(false);
  });

  it("🔴 an UNKNOWN employment status can never produce leaver_still_enabled", () => {
    // A company without the HR module yields no statuses. Treating unknown as terminated would flag
    // every enabled login as a leaver; treating it as active is what this does — and the point is that
    // the leaver claim is only ever made from real data.
    const row = deriveRow(member, kc(), { verified_at: new Date() }, null);
    expect(row.state).toBe("enabled");
    expect(row.employmentStatus).toBeNull();
  });
});

// ── the HTTP surface ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_URL || !live)("P2-13 · /api/:t/it/accounts over the real surface", () => {
  let app: NestFastifyApplication;
  let T: string;
  let itAdmin: string;
  let plainMember: string;
  let joiner: string;
  const realFetch = globalThis.fetch;
  let kcCalls: Array<{ method: string; url: string }> = [];
  /** The stub's view of the realm, keyed by email. */
  let realm: Map<string, { id: string; enabled: boolean }>;

  beforeAll(async () => {
    await initTestDb();
    // Without this the `x-user-id` impersonation header is refused and every case below is a 401 —
    // the same setup every sibling suite does (employees-jml.test.ts:99).
    config.serviceToken = "svc-token";
    T = await createCompany("P2-13 IT Co");
    const itRole = await createRole("it_admin");
    itAdmin = await createUser("it.admin@ex.com", "IT Admin");
    plainMember = await createUser("plain.member@ex.com", "Plain Member");
    joiner = await createUser("new.joiner@ex.com", "New Joiner");
    for (const u of [itAdmin, plainMember, joiner]) await addMembership(T, u, "employee");
    await grantRole(itAdmin, itRole, "company", T);
    app = await buildApp();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  function stubKeycloak(): void {
    kcCalls = [];
    const stub = vi.fn(async (url: string | URL, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (!u.startsWith("http://kc.test")) return realFetch(url as never, init as never);
      kcCalls.push({ method, url: u });

      if (u.includes("/protocol/openid-connect/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "kc-token", expires_in: 300 }) } as never;
      }
      // GET /users?email=...&exact=true
      if (method === "GET" && u.includes("/users?")) {
        const email = decodeURIComponent(new URL(u).searchParams.get("email") ?? "");
        const found = realm.get(email);
        return {
          ok: true, status: 200,
          json: async () => (found ? [{ id: found.id, email, enabled: found.enabled, emailVerified: true }] : []),
        } as never;
      }
      // POST /users
      if (method === "POST" && u.endsWith("/users")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
        const email = body.email ?? "";
        if (realm.has(email)) return { ok: false, status: 409, text: async () => "exists" } as never;
        const id = `kc-${realm.size + 1}`;
        realm.set(email, { id, enabled: true });
        return { ok: true, status: 201, headers: { get: () => `/users/${id}` }, text: async () => "" } as never;
      }
      // PUT /users/:id  (enable/disable) and PUT /users/:id/reset-password
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
        if (typeof body.enabled === "boolean") {
          for (const [email, rec] of realm) if (u.includes(rec.id)) realm.set(email, { ...rec, enabled: body.enabled });
        }
        return { ok: true, status: 204, text: async () => "" } as never;
      }
      return { ok: true, status: 204, text: async () => "" } as never;
    });
    vi.stubGlobal("fetch", stub as unknown as typeof fetch);
  }

  beforeEach(() => {
    realm = new Map();
    config.keycloakAdmin = { baseUrl: "http://kc.test", realm: "gaiada", clientId: "prov", clientSecret: "s3cret" };
    resetKeycloakAdminTokenCache();
    stubKeycloak();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/${T}/it/accounts`, headers });
  const act = (userId: string, action: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/api/${T}/it/accounts/${userId}/${action}`, headers, payload });

  // ── degradation ────────────────────────────────────────────────────────────────────────────────

  it("🔴 with NO admin client configured the worklist is a typed 503, never an empty list", async () => {
    config.keycloakAdmin = { baseUrl: "", realm: "", clientId: "", clientSecret: "" };
    const res = await get(asUser(itAdmin));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain(IT_ACCOUNT_ERROR.notConfigured);
  });

  it("every action also refuses with the same typed 503 when unconfigured", async () => {
    config.keycloakAdmin = { baseUrl: "", realm: "", clientId: "", clientSecret: "" };
    for (const action of ["provision", "disable", "enable", "reset-password"]) {
      const res = await act(joiner, action, asUser(itAdmin));
      expect(res.statusCode, action).toBe(503);
      expect(res.json().error, action).toContain(IT_ACCOUNT_ERROR.notConfigured);
    }
  });

  // ── authorization ──────────────────────────────────────────────────────────────────────────────

  it("an it_admin reads the worklist; a plain member is refused", async () => {
    expect((await get(asUser(itAdmin))).statusCode).toBe(200);
    expect((await get(asUser(plainMember))).statusCode).toBe(403);
  });

  it("a plain member cannot provision, disable, enable, or reset anyone's password", async () => {
    for (const action of ["provision", "disable", "enable", "reset-password"]) {
      expect((await act(joiner, action, asUser(plainMember))).statusCode, action).toBe(403);
    }
  });

  it("🔴 refuses to touch someone who is not a staff member of THIS company", async () => {
    // An authorized IT admin acting on another company's employee. Authorization says "you may manage
    // accounts here"; it does not say "this person is yours".
    const outsider = await createUser("outsider@ex.com", "Outsider");
    const res = await act(outsider, "provision", asUser(itAdmin));
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain(IT_ACCOUNT_ERROR.notAMember);
  });

  // ── the worklist ───────────────────────────────────────────────────────────────────────────────

  it("derives a joiner as `missing` and an existing account as `enabled`", async () => {
    realm.set("it.admin@ex.com", { id: "kc-existing", enabled: true });
    const res = await get(asUser(itAdmin));
    expect(res.statusCode).toBe(200);
    const rows = res.json().accounts as Array<{ email: string; state: string; actionable: boolean }>;
    expect(rows.find((r) => r.email === "new.joiner@ex.com")!.state).toBe("missing");
    expect(rows.find((r) => r.email === "it.admin@ex.com")!.state).toBe("enabled");
  });

  it("🔴 a terminated employee with an enabled login shows as leaver_still_enabled", async () => {
    realm.set("plain.member@ex.com", { id: "kc-leaver", enabled: true });
    await withTenants(
      [T],
      (c) =>
        c.query(
          `INSERT INTO employees (id, tenant_id, user_id, display_name, work_email, employment_status)
           VALUES ($1,$2,$3,'Plain Member','plain.member@ex.com','terminated')
           ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL
             DO UPDATE SET employment_status = 'terminated'`,
          [newId(), T, plainMember],
        ),
      HR,
    );

    const rows = (await get(asUser(itAdmin))).json().accounts as Array<{ email: string; state: string }>;
    expect(rows.find((r) => r.email === "plain.member@ex.com")!.state).toBe("leaver_still_enabled");
  });

  it("service accounts never appear on the worklist", async () => {
    const bot = await createUser("automation+p213@gaiada.system", "Bot");
    await addMembership(T, bot, "service");
    const rows = (await get(asUser(itAdmin))).json().accounts as Array<{ email: string }>;
    expect(rows.map((r) => r.email)).not.toContain("automation+p213@gaiada.system");
  });

  // ── provision: idempotence and the display-once password ───────────────────────────────────────

  it("provisions a joiner, returns the initial password ONCE, and links the account", async () => {
    const res = await act(joiner, "provision", asUser(itAdmin));
    expect(res.statusCode).toBe(201);
    const body = res.json() as { keycloakId: string; initialPassword: string | null; adopted: boolean };
    expect(body.adopted).toBe(false);
    expect(body.initialPassword).toBeTruthy();
    expect(body.initialPassword!.length).toBeGreaterThanOrEqual(12);

    const links = await withGlobal((c) =>
      c.query<{ external_id: string; verified_at: Date | null }>(
        `SELECT external_id, verified_at FROM identity_links WHERE user_id = $1 AND provider = 'platform'`,
        [joiner],
      ),
    );
    expect(links.rows[0].external_id).toBe(body.keycloakId);
    // UNVERIFIED: an admin creating an account is not the person proving control of it.
    expect(links.rows[0].verified_at).toBeNull();
  });

  it("🔴 a DOUBLE provision converges — adopts, never a second login, and no password the second time", async () => {
    const first = await act(joiner, "provision", asUser(itAdmin));
    expect(first.statusCode).toBe(201);
    const created = first.json().keycloakId as string;

    const second = await act(joiner, "provision", asUser(itAdmin));
    expect(second.statusCode).toBe(201);
    const body = second.json() as { keycloakId: string; initialPassword: string | null; adopted: boolean };
    expect(body.adopted).toBe(true);
    expect(body.keycloakId).toBe(created);
    // No password: the account already existed and its credential is not ours to silently rotate.
    expect(body.initialPassword).toBeNull();
    expect([...realm.keys()].filter((e) => e === "new.joiner@ex.com")).toHaveLength(1);
  });

  it("adopts a PRE-EXISTING hand-made account rather than failing or duplicating", async () => {
    realm.set("new.joiner@ex.com", { id: "kc-by-hand", enabled: true });
    const res = await act(joiner, "provision", asUser(itAdmin));
    expect(res.json()).toMatchObject({ keycloakId: "kc-by-hand", adopted: true, initialPassword: null });
    // POST /users was never attempted — the lookup came first.
    expect(kcCalls.filter((c) => c.method === "POST" && c.url.endsWith("/users"))).toHaveLength(0);
  });

  it("the initial password is NOT written to the audit trail", async () => {
    const res = await act(joiner, "provision", asUser(itAdmin));
    const password = res.json().initialPassword as string;
    const rows = await withTenants([T], (c) =>
      c.query<{ metadata: unknown }>(
        `SELECT metadata FROM activities WHERE tenant_id = $1 AND verb = 'it.account.provision'`,
        [T],
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(JSON.stringify(r.metadata)).not.toContain(password);
  });

  // ── disable / enable / reset ───────────────────────────────────────────────────────────────────

  it("disable is idempotent and reports whether it actually acted", async () => {
    realm.set("plain.member@ex.com", { id: "kc-d", enabled: true });
    const first = await act(plainMember, "disable", asUser(itAdmin));
    expect(first.json()).toEqual({ ok: true, alreadyDisabled: false });
    const second = await act(plainMember, "disable", asUser(itAdmin));
    expect(second.json()).toEqual({ ok: true, alreadyDisabled: true });
    // The second call issues no PUT — "nothing to do" rather than a redundant upstream write.
    expect(kcCalls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("enable is idempotent the same way", async () => {
    realm.set("plain.member@ex.com", { id: "kc-e", enabled: false });
    expect((await act(plainMember, "enable", asUser(itAdmin))).json()).toEqual({ ok: true, alreadyEnabled: false });
    expect((await act(plainMember, "enable", asUser(itAdmin))).json()).toEqual({ ok: true, alreadyEnabled: true });
  });

  it("🔴 disable/enable/reset REFUSE when there is no account, instead of silently succeeding", async () => {
    for (const action of ["disable", "enable", "reset-password"]) {
      const res = await act(joiner, action, asUser(itAdmin));
      expect(res.statusCode, action).toBe(400);
      expect(res.json().error, action).toContain(IT_ACCOUNT_ERROR.noAccount);
    }
  });

  it("reset-password returns a fresh password and records the REASON, not the password", async () => {
    realm.set("plain.member@ex.com", { id: "kc-r", enabled: true });
    const res = await act(plainMember, "reset-password", asUser(itAdmin), { reason: "locked out, verified by phone" });
    expect(res.statusCode).toBe(200);
    const password = res.json().initialPassword as string;
    expect(password.length).toBeGreaterThanOrEqual(12);

    const rows = await withTenants([T], (c) =>
      c.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM activities WHERE tenant_id = $1 AND verb = 'it.account.reset_password'`,
        [T],
      ),
    );
    expect(rows.rows[0].metadata.reason).toBe("locked out, verified by phone");
    expect(JSON.stringify(rows.rows[0].metadata)).not.toContain(password);
  });

  it("an upstream Keycloak failure is a typed 502, distinct from 'not configured'", async () => {
    // One is their outage, the other is our wiring, and an operator needs to know which.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: { method?: string }) => {
        const u = String(url);
        if (u.includes("/protocol/openid-connect/token")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 300 }) } as never;
        }
        if (u.startsWith("http://kc.test")) return { ok: false, status: 500, text: async () => "boom" } as never;
        return realFetch(url as never, init as never);
      }) as unknown as typeof fetch,
    );
    const res = await get(asUser(itAdmin));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain(IT_ACCOUNT_ERROR.upstreamFailed);
  });
});
