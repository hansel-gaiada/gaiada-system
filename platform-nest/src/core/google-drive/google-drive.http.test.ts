// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42.7) — Google Drive: connect, pick and attach, driven over HTTP against real Postgres (RLS on)
// and real Cerbos, with GOOGLE STUBBED AT `fetch`.
//
// THE STUB. The Drive OAuth client does not exist yet (owner step DW-11 item 6), so `setDriveHttpForTests` hands the REAL shared token
// client (core/google-oauth/token-endpoint-client.ts) and the REAL Drive client (./client.ts) one fake `fetch`. It answers with JSON in the
// shapes Google documents (see the headers of client.ts and id-token.ts): the OAuth 2.0 token response (`access_token`, `expires_in`,
// `refresh_token`, `scope`, `token_type`, `id_token`), the revoke endpoint's empty 200, Drive v3 `files.get` and its `{ error: { code,
// message, errors: [{ reason }] } }` bodies. It records every request, which is how "Google was not called" and "called once" are asserted.
// Live proof (one real account, one real file) waits for DW-11 item 6.
//
// What is covered (each bullet of §42.7 that needs a database):
//   * start, then callback with a stubbed token exchange; the manual row upgraded in place; one row per person;
//   * every state failure is typed (`drive_state_invalid`, `drive_consent_denied`, `drive_exchange_failed`), never a 500, and the
//     tenant and the person come only from the verified state;
//   * the Picker read: configured:false, connected:false, a live token, a refresh (inside five minutes only), rotation, needs_reconnect;
//   * disconnect clears the tokens and calls revoke; attachments stay;
//   * attach: authorisation before validation, another tenant's task 404, an unreachable file 404 `drive_file_not_found`, the same file
//     twice 409 `drive_already_attached`, and the written row carries DRIVE's name, MIME type and link (not the browser's);
//   * THE SECRET RULE: no token, id token, auth code or client secret appears in any response except the Picker's access token, in any
//     error, or in any activity row, event, connection row or file row.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what is
// asserted is what committed), and every refusal also asserts that nothing was written and that Google was not called.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, createTask } from "../../testing/fixtures";
import { decryptSecret } from "../secret-box";
import { setDriveHttpForTests } from "./service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ───────────────────────────────────────────── the Google stub ─────────────────────────────────────────────

const CLIENT_ID = "drive-client-0001.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-DRIVE-CLIENT-SECRET-0001";
const REDIRECT = "https://erp.example.test/api/google-drive/callback";
const API_KEY = "AIzaSy-PICKER-BROWSER-KEY-0001";
const APP_ID = "123456789012";
const ACCESS_1 = "ya29.DRIVE-ACCESS-ONE";
const REFRESH_1 = "1//DRIVE-REFRESH-ONE";
const REFRESH_2 = "1//DRIVE-REFRESH-TWO-ROTATED";
const CODE = "4/0AX4XfWh-DRIVE-AUTH-CODE-0001";
const FULL_SCOPE = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";

const FILE_1 = "1AbCdEfGhIjKlMnOpQrStUvWx_0001";
const FILE_2 = "1ZyXwVuTsRqPoNmLkJiHgFeDc_0002";
const FILE_GONE = "1NoSuchFileNoSuchFileNo_0003";
const DRIVE_FILES: Record<string, { id: string; name: string; mimeType: string; webViewLink: string }> = {
  [FILE_1]: { id: FILE_1, name: "Brand brief.pdf", mimeType: "application/pdf", webViewLink: `https://drive.google.com/file/d/${FILE_1}/view?usp=drivesdk` },
  [FILE_2]: { id: FILE_2, name: "Launch plan", mimeType: "application/vnd.google-apps.document", webViewLink: `https://docs.google.com/document/d/${FILE_2}/edit?usp=drivesdk` },
};

interface Seen { kind: "exchange" | "refresh" | "revoke" | "drive"; url: string; form?: Record<string, string>; auth?: string }
const fresh = () => ({
  email: "dana@gmail.test",
  aud: CLIENT_ID,
  scope: FULL_SCOPE,
  noRefreshToken: false,
  noIdToken: false,
  exchange: "ok" as "ok" | "refused",
  refresh: "ok" as "ok" | "invalid_grant" | "down",
  rotate: false,
  revoke: "ok" as "ok" | "down",
  drive: "ok" as "ok" | "down",
  driveRejectsAll: false,
  validAccess: new Set<string>(),
  n: 0,
  seen: [] as Seen[],
  idTokens: [] as string[],
});
let fx = fresh();

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mkIdToken = () => {
  const now = Math.floor(Date.now() / 1000);
  const t = `${b64({ alg: "RS256", typ: "JWT", kid: "stub-key" })}.${b64({
    iss: "https://accounts.google.com", azp: CLIENT_ID, aud: fx.aud, sub: "109876543210987654321", email: fx.email,
    email_verified: true, iat: now, exp: now + 3600,
  })}.c3R1Yi1zaWduYXR1cmU`;
  fx.idTokens.push(t);
  return t;
};

const stub = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const u = new URL(url);
  const body = typeof init?.body === "string" ? init.body : "";
  const headers = (init?.headers ?? {}) as Record<string, string>;

  if (u.origin === "https://oauth2.googleapis.com" && u.pathname === "/token") {
    const form = Object.fromEntries(new URLSearchParams(body));
    if (form.grant_type === "refresh_token") {
      fx.seen.push({ kind: "refresh", url, form });
      if (fx.refresh === "invalid_grant") return jsonRes({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      if (fx.refresh === "down") return jsonRes({ error: "server_error" }, 500);
      const access = `ya29.DRIVE-REFRESHED-${++fx.n}`;
      fx.validAccess.add(access);
      return jsonRes({ access_token: access, expires_in: 3599, scope: fx.scope, token_type: "Bearer", ...(fx.rotate ? { refresh_token: REFRESH_2 } : {}) });
    }
    fx.seen.push({ kind: "exchange", url, form });
    if (fx.exchange === "refused") return jsonRes({ error: "invalid_grant", error_description: "Bad Request" }, 400);
    fx.validAccess.add(ACCESS_1);
    return jsonRes({
      access_token: ACCESS_1, expires_in: 3599, scope: fx.scope, token_type: "Bearer",
      ...(fx.noRefreshToken ? {} : { refresh_token: REFRESH_1 }),
      ...(fx.noIdToken ? {} : { id_token: mkIdToken() }),
    });
  }
  if (u.origin === "https://oauth2.googleapis.com" && u.pathname === "/revoke") {
    fx.seen.push({ kind: "revoke", url, form: Object.fromEntries(new URLSearchParams(body)) });
    return fx.revoke === "down" ? jsonRes({ error: "server_error" }, 500) : new Response("", { status: 200 });
  }
  if (u.origin === "https://www.googleapis.com" && u.pathname.startsWith("/drive/v3/files/")) {
    const auth = headers.authorization ?? "";
    fx.seen.push({ kind: "drive", url, auth });
    if (fx.drive === "down") return jsonRes({ error: { code: 503, message: "x", errors: [{ reason: "backendError", message: "x" }] } }, 503);
    if (fx.driveRejectsAll || !fx.validAccess.has(auth.replace(/^Bearer /, ""))) {
      return jsonRes({ error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError", message: "Invalid Credentials" }] } }, 401);
    }
    const file = DRIVE_FILES[decodeURIComponent(u.pathname.slice("/drive/v3/files/".length))];
    if (!file) return jsonRes({ error: { code: 404, message: "File not found", errors: [{ reason: "notFound", message: "File not found" }] } }, 404);
    return jsonRes({ ...file, kind: "drive#file" });
  }
  throw new Error(`the Drive suite's Google stub was asked for an unexpected URL: ${url}`);
}) as typeof fetch;

const calls = (kind: Seen["kind"]) => fx.seen.filter((s) => s.kind === kind);

// ───────────────────────────────────────────── the suite ─────────────────────────────────────────────

describe.skipIf(!TEST_URL)("DW-6i · Google Drive: connect, pick and attach (§42)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let mgr: string;
  let mgr2: string;
  let member: string;
  let viewer: string;
  let stranger: string;
  let mgrB: string;
  let taskA: string;
  let taskA2: string;
  let taskB: string;
  const savedDrive = { ...config.googleDrive };

  /** Every response body the suite ever received, for the final secret scan. `picker` marks a Picker answer (the one place an
   *  ACCESS token may appear). */
  const wire: Array<{ label: string; text: string; picker: boolean }> = [];
  const q = adminPool;

  async function call(method: "GET" | "POST" | "DELETE" | "PATCH", url: string, userId: string, payload?: unknown) {
    const res = await app.inject({ method, url, headers: asUser(userId), ...(payload !== undefined ? { payload: payload as object } : {}) });
    wire.push({ label: `${method} ${url.split("?")[0]}`, text: res.body, picker: /\/google-drive\/picker$/.test(url) && res.statusCode === 200 });
    return res;
  }
  const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;
  const reasonOf = (r: { json: () => unknown }) => json(r).reason as string;
  const errorOf = (r: { json: () => unknown }) => json(r).error as string;

  const start = (as: string, tenant = A) => call("GET", `/api/${tenant}/integrations/google-drive/oauth/start`, as);
  const callback = (as: string, qs: string) => call("GET", `/api/google-drive/oauth/callback?${qs}`, as);
  const picker = (as: string, tenant = A) => call("GET", `/api/${tenant}/integrations/google-drive/picker`, as);
  const disconnect = (as: string, tenant = A) => call("DELETE", `/api/${tenant}/integrations/google-drive`, as);
  const attach = (as: string, body: unknown, tenant = A) => call("POST", `/api/${tenant}/integrations/google-drive/attach`, as, body);
  const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get("state") as string;

  /** Start and complete the flow as `as`; returns the callback response. */
  async function connect(as: string) {
    const s = await start(as);
    expect(s.statusCode, s.body).toBe(200);
    const cb = await callback(as, `code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(stateOf(json(s).authUrl))}`);
    return cb;
  }
  async function connectOk(as: string) {
    const cb = await connect(as);
    expect(cb.statusCode, cb.body).toBe(200);
    expect(json(cb).status).toBe("connected");
  }
  const rowOf = async (userId: string, tenant = A) =>
    (await q().query(`SELECT * FROM integration_connections WHERE tenant_id = $1 AND owner_kind = 'user' AND owner_id = $2 AND provider = 'google_drive'`, [tenant, userId])).rows[0];
  const rowCount = async (userId: string, tenant = A) =>
    Number((await q().query(`SELECT count(*)::int AS n FROM integration_connections WHERE tenant_id = $1 AND owner_kind = 'user' AND owner_id = $2 AND provider = 'google_drive'`, [tenant, userId])).rows[0].n);
  const filesOn = async (taskId: string) =>
    (await q().query(`SELECT * FROM files WHERE target_entity_type = 'task' AND target_entity_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [taskId])).rows;
  const fileCount = async () => Number((await q().query(`SELECT count(*)::int AS n FROM files WHERE tenant_id = ANY($1::uuid[])`, [[A, B]])).rows[0].n);
  /** Activity rows of one verb on one entity (rows from earlier tests are never mistaken for this test's). */
  const activityRows = async (verb: string, entityId: string, tenant = A) =>
    (await q().query(`SELECT * FROM activities WHERE tenant_id = $1 AND verb = $2 AND target_entity_id = $3 ORDER BY occurred_at`, [tenant, verb, entityId])).rows;
  const expireIn = (userId: string, interval: string) =>
    q().query(`UPDATE integration_connections SET token_expires_at = now() + $3::interval WHERE tenant_id = $1 AND owner_id = $2 AND provider = 'google_drive'`, [A, userId, interval]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = randomBytes(32).toString("base64");
    Object.assign(config.googleDrive, {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, pickerApiKey: API_KEY, pickerAppId: APP_ID,
    });
    setDriveHttpForTests(stub);

    A = await createCompany("Drive Agency A", ["pm"]);
    B = await createCompany("Drive Agency B", ["pm"]);
    const mk = async (email: string) => createUser(`${email}@dw6i.test`, email);
    mgr = await mk("mgr"); mgr2 = await mk("mgr2"); member = await mk("member"); viewer = await mk("viewer");
    stranger = await mk("stranger"); mgrB = await mk("mgrb");
    for (const u of [mgr, mgr2, member, viewer]) await addMembership(A, u);
    await addMembership(B, mgrB);
    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");
    await grantRole(mgr, managerRole, "company", A);
    await grantRole(mgr2, managerRole, "company", A);
    await grantRole(member, memberRole, "company", A);
    await grantRole(viewer, viewerRole, "company", A);
    await grantRole(mgrB, managerRole, "company", B);

    const projA = await createProject(A, "Drive project A", mgr);
    taskA = await createTask(A, projA, "Task A1");
    taskA2 = await createTask(A, projA, "Task A2");
    const projB = await createProject(B, "Drive project B", mgrB);
    taskB = await createTask(B, projB, "Task B1");
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    setDriveHttpForTests(null);
    Object.assign(config.googleDrive, savedDrive);
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    fx = fresh();
    await q().query(`DELETE FROM google_oauth_states WHERE provider = 'google_drive'`);
    await q().query(`DELETE FROM files WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await q().query(`DELETE FROM integration_connections WHERE provider = 'google_drive'`);
    Object.assign(config.googleDrive, {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, pickerApiKey: API_KEY, pickerAppId: APP_ID,
    });
  });

  // ═══════════════════════════════════════════════ not configured ═══════════════════════════════════════════════

  describe("not configured (§42.2: no default is ever invented)", () => {
    it("start, callback and attach answer 503 drive_not_configured; the Picker answers configured:false; Google is not called", async () => {
      await connectOk(member); // a live connection first, so `configured:false` is proved to win over a connected row
      fx.seen.length = 0;
      for (const key of ["clientId", "clientSecret", "redirectUri", "pickerApiKey", "pickerAppId"] as const) {
        const keep = config.googleDrive[key];
        config.googleDrive[key] = "";
        try {
          const s = await start(member);
          expect(s.statusCode, key).toBe(503);
          expect(reasonOf(s)).toBe("drive_not_configured");
          expect(errorOf(s).startsWith("drive_not_configured:")).toBe(true);

          const cb = await callback(member, `code=x&state=y`);
          expect(cb.statusCode, key).toBe(503);
          expect(reasonOf(cb)).toBe("drive_not_configured");

          const at = await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_1 });
          expect(at.statusCode, key).toBe(503);
          expect(reasonOf(at)).toBe("drive_not_configured");

          const p = await picker(member);
          expect(p.statusCode, key).toBe(200);
          expect(json(p)).toEqual({
            configured: false, connected: false, needsReconnect: false, accountEmail: null, accessToken: null, expiresAt: null, apiKey: null, appId: null,
          });
          expect(p.headers["cache-control"]).toBe("no-store");
        } finally { config.googleDrive[key] = keep; }
      }
      expect(fx.seen).toEqual([]);
      expect(await filesOn(taskA)).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════ connect ═══════════════════════════════════════════════

  describe("start (§42.3)", () => {
    it("answers { authUrl } for Google's consent screen: offline, consent, PKCE, our client, the three scopes, a signed state", async () => {
      const r = await start(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(Object.keys(json(r))).toEqual(["authUrl"]);
      const url = new URL(json(r).authUrl);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const p = url.searchParams;
      expect(p.get("client_id")).toBe(CLIENT_ID);
      expect(p.get("redirect_uri")).toBe(REDIRECT);
      expect(p.get("response_type")).toBe("code");
      expect(p.get("scope")).toBe("https://www.googleapis.com/auth/drive.file openid email");
      expect(p.get("access_type")).toBe("offline");
      expect(p.get("prompt")).toBe("consent");
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get("state")).toMatch(/^gs1\./);
      expect(json(r).authUrl).not.toContain(CLIENT_SECRET);
      expect(fx.seen).toEqual([]); // building the URL never calls Google
    });
    it("writes ONE state row: core (no module), the person's own, with the verifier sealed", async () => {
      const r = await start(member);
      const st = await q().query(`SELECT * FROM google_oauth_states WHERE provider = 'google_drive' AND tenant_id = $1`, [A]);
      expect(st.rows).toHaveLength(1);
      expect(st.rows[0]).toMatchObject({ tenant_id: A, owner_kind: "user", owner_id: member, module: null, created_by: member, redirect_uri: REDIRECT, consumed_at: null, code_challenge_method: "S256" });
      expect(st.rows[0].scopes).toEqual(["https://www.googleapis.com/auth/drive.file", "openid", "email"]);
      expect(String(st.rows[0].code_verifier_enc).startsWith("enc:v1:")).toBe(true);
      expect(json(r).authUrl).toContain(encodeURIComponent(st.rows[0].code_challenge));
    });
    it("a person outside the company is refused (403) and nothing is written", async () => {
      const r = await start(stranger);
      expect(r.statusCode).toBe(403);
      expect((await q().query(`SELECT 1 FROM google_oauth_states WHERE provider = 'google_drive'`)).rows).toEqual([]);
    });
  });

  describe("callback (§42.3)", () => {
    it("exchanges the code through the shared token client and seals the tokens in the person's own row", async () => {
      const cb = await connect(member);
      expect(cb.statusCode, cb.body).toBe(200);
      expect(json(cb)).toEqual({ status: "connected", accountEmail: "dana@gmail.test" });

      // One exchange, with OUR Drive client's credentials, the code and the PKCE verifier.
      expect(calls("exchange")).toHaveLength(1);
      const form = calls("exchange")[0].form!;
      expect(form).toMatchObject({ grant_type: "authorization_code", code: CODE, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT });
      expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(calls("exchange")[0].url).toBe("https://oauth2.googleapis.com/token");

      const row = await rowOf(member);
      expect(row).toMatchObject({ owner_kind: "user", owner_id: member, provider: "google_drive", status: "linked", external_account: "dana@gmail.test", token_key_version: "v1" });
      expect(String(row.access_token_enc).startsWith("enc:v1:")).toBe(true);
      expect(String(row.refresh_token_enc).startsWith("enc:v1:")).toBe(true);
      expect(decryptSecret(row.access_token_enc)).toBe(ACCESS_1);
      expect(decryptSecret(row.refresh_token_enc)).toBe(REFRESH_1);
      expect(row.scopes).toEqual(FULL_SCOPE.split(" "));
      const secs = (new Date(row.token_expires_at).getTime() - Date.now()) / 1000;
      expect(secs).toBeGreaterThan(3400);
      expect(secs).toBeLessThanOrEqual(3600);
      expect(row.meta).toMatchObject({ googleIssuerHost: "accounts.google.com", googleIssuerIsGoogle: true, googleSub: "109876543210987654321", googleEmailVerified: true });
      expect(JSON.stringify(row.meta)).not.toContain("ya29");

      // The state row is spent and points at the connection.
      const st = await q().query(`SELECT consumed_at, connection_id FROM google_oauth_states WHERE provider = 'google_drive'`);
      expect(st.rows[0].consumed_at).not.toBeNull();
      expect(st.rows[0].connection_id).toBe(row.id);

      // One audit row: that it was connected, never a token or the email.
      const act = await activityRows("connected", row.id);
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ actor_id: member, target_entity_type: "integration_connection", target_entity_id: row.id });
      expect(act[0].metadata).toMatchObject({ provider: "google_drive" });
      expect(Object.keys(act[0].metadata).filter((k) => k !== "via")).toEqual(["provider"]);
    });

    it("UPGRADES the manual row in place: same row, the verified email, the manual meta kept, still one row", async () => {
      const manual = await call("POST", `/api/${A}/integrations/connections`, member, {
        provider: "google_drive", externalAccount: "typed-by-hand@x.test", meta: { note: "typed by hand" },
      });
      expect(manual.statusCode, manual.body).toBe(201);
      const manualId = json(manual).id as string;
      expect(await rowCount(member)).toBe(1);
      expect(await (rowOf(member))).toMatchObject({ status: "unconfigured", access_token_enc: null });

      await connectOk(member);
      expect(await rowCount(member)).toBe(1);
      const row = await rowOf(member);
      expect(row.id).toBe(manualId);
      expect(row).toMatchObject({ status: "linked", external_account: "dana@gmail.test" });
      expect(row.meta).toMatchObject({ note: "typed by hand", googleIssuerIsGoogle: true });
      expect(decryptSecret(row.access_token_enc)).toBe(ACCESS_1);
    });

    it("keeps ONE row per person: a reconnect reuses the row, and another person gets their own", async () => {
      await connectOk(member);
      const first = await rowOf(member);
      await connectOk(member);
      expect(await rowCount(member)).toBe(1);
      expect((await rowOf(member)).id).toBe(first.id);

      fx.email = "lee@gmail.test";
      await connectOk(mgr);
      expect(await rowCount(mgr)).toBe(1);
      const mine = await rowOf(mgr);
      expect(mine.id).not.toBe(first.id);
      expect(mine.external_account).toBe("lee@gmail.test");
      expect((await rowOf(member)).external_account).toBe("dana@gmail.test"); // the first person's row is untouched
    });

    it("a re-consent that returns no refresh token keeps the one already sealed", async () => {
      await connectOk(member);
      fx.noRefreshToken = true;
      await connectOk(member);
      expect(decryptSecret((await rowOf(member)).refresh_token_enc)).toBe(REFRESH_1);
    });

    it("a first consent with no refresh token still connects (the Picker works until the hour is up, then asks for a reconnect)", async () => {
      fx.noRefreshToken = true;
      await connectOk(member);
      const row = await rowOf(member);
      expect(row.refresh_token_enc).toBeNull();
      expect(json(await picker(member))).toMatchObject({ connected: true, accessToken: ACCESS_1 });
      await expireIn(member, "1 minute");
      expect(json(await picker(member))).toMatchObject({ connected: false, needsReconnect: true, accessToken: null });
      expect(calls("refresh")).toEqual([]); // nothing to refresh WITH
    });

    describe("every failure is typed, never a 500, and spends the state", () => {
      it("missing code or state, a forged signature, a malformed state: 400 drive_state_invalid, Google not called", async () => {
        const s = await start(member);
        const state = stateOf(json(s).authUrl);
        const [p0, p1, p2, sig] = state.split(".");
        const forged = `${p0}.${p1}.${p2}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
        const otherTenant = `${p0}.${p1}.${Buffer.from(B).toString("base64url")}.${sig}`;
        for (const qs of [`state=${state}`, `code=${CODE}`, `code=${CODE}&state=`, `code=${CODE}&state=junk`, `code=${CODE}&state=${forged}`, `code=${CODE}&state=${otherTenant}`, ""]) {
          const r = await callback(member, qs);
          expect(r.statusCode, qs).toBe(400);
          expect(reasonOf(r), qs).toBe("drive_state_invalid");
          expect(errorOf(r).startsWith("drive_state_invalid:")).toBe(true);
        }
        expect(fx.seen).toEqual([]);
        expect(await rowCount(member)).toBe(0);
        // The real state was never spent by any of those, so the real callback still works.
        const ok = await callback(member, `code=${CODE}&state=${state}`);
        expect(ok.statusCode, ok.body).toBe(200);
      });

      it("a replay of a spent state is refused (drive_state_invalid) and exchanges nothing", async () => {
        const s = await start(member);
        const state = stateOf(json(s).authUrl);
        expect((await callback(member, `code=${CODE}&state=${state}`)).statusCode).toBe(200);
        const again = await callback(member, `code=${CODE}&state=${state}`);
        expect(again.statusCode).toBe(400);
        expect(reasonOf(again)).toBe("drive_state_invalid");
        expect(calls("exchange")).toHaveLength(1);
      });

      it("another person presenting the state is refused and the state is spent; the tenant comes only from the state, never the query", async () => {
        const s = await start(member);
        const state = stateOf(json(s).authUrl);
        // `mgr` is a member of the same company, so the surface's own check passes and the state itself refuses (principal mismatch).
        const r = await callback(mgr, `code=${CODE}&state=${state}&tenantId=${B}&t=${B}&ownerId=${mgr}`);
        expect(r.statusCode).toBe(400);
        expect(reasonOf(r)).toBe("drive_state_invalid");
        expect(fx.seen).toEqual([]);
        expect(await rowCount(mgr)).toBe(0);
        expect((await q().query(`SELECT 1 FROM integration_connections WHERE tenant_id = $1 AND provider = 'google_drive'`, [B])).rows).toEqual([]);
        // The owner of the state finds it spent: a state fed to a failing callback is not retryable.
        const late = await callback(member, `code=${CODE}&state=${state}`);
        expect(late.statusCode).toBe(400);
      });

      it("a caller the surface's Cerbos check refuses is refused (403) BEFORE the state is spent, so a re-permissioned retry works", async () => {
        const s = await start(member);
        const state = stateOf(json(s).authUrl);
        const r = await callback(stranger, `code=${CODE}&state=${state}`);
        expect(r.statusCode).toBe(403);
        expect(fx.seen).toEqual([]);
        const ok = await callback(member, `code=${CODE}&state=${state}`);
        expect(ok.statusCode, ok.body).toBe(200);
      });

      it("consent denied at Google's screen: 200 { status: denied, reason: drive_consent_denied }; nothing touched", async () => {
        await start(member);
        const r = await callback(member, `error=access_denied&error_description=The+user+denied`);
        expect(r.statusCode).toBe(200);
        expect(json(r)).toEqual({ status: "denied", reason: "drive_consent_denied" });
        expect(fx.seen).toEqual([]);
        expect(await rowCount(member)).toBe(0);
      });

      it("Drive access unticked on a granular consent screen (a token without drive.file) is the same denial and seals nothing", async () => {
        fx.scope = "openid https://www.googleapis.com/auth/userinfo.email";
        const cb = await connect(member);
        expect(cb.statusCode, cb.body).toBe(200);
        expect(json(cb)).toEqual({ status: "denied", reason: "drive_consent_denied" });
        expect(calls("exchange")).toHaveLength(1);
        expect(await rowCount(member)).toBe(0);
      });

      it("the token endpoint refusing the code: 502 drive_exchange_failed, nothing sealed, and no code or secret in the answer", async () => {
        fx.exchange = "refused";
        const cb = await connect(member);
        expect(cb.statusCode).toBe(502);
        expect(reasonOf(cb)).toBe("drive_exchange_failed");
        expect(errorOf(cb).startsWith("drive_exchange_failed:")).toBe(true);
        expect(cb.body).not.toContain(CODE);
        expect(cb.body).not.toContain(CLIENT_SECRET);
        expect(await rowCount(member)).toBe(0);
      });

      it("an ID token for another app (wrong audience), or none at all: 502 drive_exchange_failed and nothing sealed", async () => {
        fx.aud = "someone-elses-client.apps.googleusercontent.com";
        const wrongAud = await connect(member);
        expect(wrongAud.statusCode).toBe(502);
        expect(reasonOf(wrongAud)).toBe("drive_exchange_failed");
        expect(await rowCount(member)).toBe(0);

        fx.aud = CLIENT_ID;
        fx.noIdToken = true;
        const none = await connect(member);
        expect(none.statusCode).toBe(502);
        expect(reasonOf(none)).toBe("drive_exchange_failed");
        expect(await rowCount(member)).toBe(0);
      });
    });
  });

  // ═══════════════════════════════════════════════ pick ═══════════════════════════════════════════════

  describe("the Picker read (§42.4)", () => {
    it("not connected: configured:true, connected:false, no token, no key; Cache-Control no-store; Google not called", async () => {
      const r = await picker(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({
        configured: true, connected: false, needsReconnect: false, accountEmail: null, accessToken: null, expiresAt: null, apiKey: null, appId: null,
      });
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(fx.seen).toEqual([]);
    });

    it("a manual row with no credential behind it reads as not connected", async () => {
      await call("POST", `/api/${A}/integrations/connections`, member, { provider: "google_drive", externalAccount: "typed-by-hand@x.test" });
      expect(json(await picker(member))).toMatchObject({ configured: true, connected: false, accessToken: null, accountEmail: null });
    });

    it("connected: a live token, its expiry, the browser key and the project number, for the caller only", async () => {
      await connectOk(member);
      fx.seen.length = 0;
      const r = await picker(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({
        configured: true, connected: true, needsReconnect: false, accountEmail: "dana@gmail.test", accessToken: ACCESS_1,
        expiresAt: expect.any(String), apiKey: API_KEY, appId: APP_ID,
      });
      expect(new Date(json(r).expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(fx.seen).toEqual([]); // fresh token: Google was not called
      expect(r.body).not.toContain(REFRESH_1); // the refresh token never leaves the server

      // Someone else, same company: their own (empty) answer, never this person's token.
      const other = await picker(mgr);
      expect(json(other)).toMatchObject({ connected: false, accessToken: null, accountEmail: null });
      expect(other.body).not.toContain(ACCESS_1);
      // A person outside the company: refused.
      expect((await picker(stranger)).statusCode).toBe(403);
    });

    it("refreshes first when the token expires within five minutes, and not before", async () => {
      await connectOk(member);
      fx.seen.length = 0;

      await expireIn(member, "10 minutes");
      expect(json(await picker(member)).accessToken).toBe(ACCESS_1);
      expect(calls("refresh")).toEqual([]);

      await expireIn(member, "2 minutes");
      const r = await picker(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(calls("refresh")).toHaveLength(1);
      expect(calls("refresh")[0].form).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH_1, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      const token = json(r).accessToken as string;
      expect(token).toMatch(/^ya29\.DRIVE-REFRESHED-/);
      expect(json(r).connected).toBe(true);

      const row = await rowOf(member);
      expect(decryptSecret(row.access_token_enc)).toBe(token);
      expect(decryptSecret(row.refresh_token_enc)).toBe(REFRESH_1); // no rotation: the existing refresh token survives
      expect(row.status).toBe("linked");
      expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

      // The next read is inside no window: no second refresh.
      expect(json(await picker(member)).accessToken).toBe(token);
      expect(calls("refresh")).toHaveLength(1);
    });

    it("stores a ROTATED refresh token when Google sends a new one", async () => {
      await connectOk(member);
      fx.rotate = true;
      await expireIn(member, "1 minute");
      expect((await picker(member)).statusCode).toBe(200);
      expect(decryptSecret((await rowOf(member)).refresh_token_enc)).toBe(REFRESH_2);
    });

    it("a refused refresh (invalid_grant) answers needsReconnect, marks the row, keeps the tokens, and is not retried on the next read", async () => {
      await connectOk(member);
      fx.refresh = "invalid_grant";
      await expireIn(member, "1 minute");
      const r = await picker(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({
        configured: true, connected: false, needsReconnect: true, accountEmail: "dana@gmail.test", accessToken: null, expiresAt: null, apiKey: null, appId: null,
      });
      const row = await rowOf(member);
      expect(row.status).toBe("error");
      expect(row.meta.driveNeedsReconnect).toBe(true);
      expect(row.access_token_enc).not.toBeNull(); // a read path must not shred a credential

      expect(calls("refresh")).toHaveLength(1);
      expect(json(await picker(member)).needsReconnect).toBe(true);
      expect(calls("refresh")).toHaveLength(1);

      // Reconnecting through the flow clears the mark and the Picker works again.
      fx.refresh = "ok";
      await connectOk(member);
      const healed = await rowOf(member);
      expect(healed.status).toBe("linked");
      expect(healed.meta.driveNeedsReconnect).toBeUndefined();
      expect(json(await picker(member))).toMatchObject({ connected: true, needsReconnect: false, accessToken: ACCESS_1 });
    });

    it("a token-endpoint OUTAGE is 502 drive_unavailable and does NOT mark the connection (the grant may be fine)", async () => {
      await connectOk(member);
      fx.refresh = "down";
      await expireIn(member, "1 minute");
      const r = await picker(member);
      expect(r.statusCode).toBe(502);
      expect(reasonOf(r)).toBe("drive_unavailable");
      expect(r.headers["cache-control"]).toBe("no-store");
      const row = await rowOf(member);
      expect(row.status).toBe("linked");
      expect(row.meta.driveNeedsReconnect).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════ attach to a PM task (pm_tasks) ═══════════════════════════════════════

  describe("attach to a PM task, the record the task page shows (§42.5)", () => {
    it("a picked Drive file attaches to a pm_tasks task: 201, and the reference row targets that task", async () => {
      // The task page (TaskDetailView) reads `pm_tasks` through `getPmTask` and attaches files as target `task` with the PM
      // task's id. The shared `createTask` fixture writes the base `tasks` table, so this case seeds a real PM task.
      const projectId = (await q().query(`SELECT project_id FROM tasks WHERE id = $1`, [taskA])).rows[0].project_id as string;
      const pmTask = randomUUID();
      await q().query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'PM task for Drive', 'central')`,
        [pmTask, A, projectId],
      );
      await connectOk(mgr2);
      const r = await attach(mgr2, { targetType: "task", targetId: pmTask, fileId: FILE_1 });
      expect(r.statusCode, r.body).toBe(201);
      const rows = await filesOn(pmTask);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ target_entity_type: "task", target_entity_id: pmTask, url: DRIVE_FILES[FILE_1].webViewLink });

      // A deleted PM task is gone again.
      await q().query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1`, [pmTask]);
      const gone = await attach(mgr2, { targetType: "task", targetId: pmTask, fileId: FILE_2 });
      expect(gone.statusCode, gone.body).toBe(404);
      expect(reasonOf(gone)).toBe("target_not_found");
    });
  });

  // ═══════════════════════════════════════════════ disconnect ═══════════════════════════════════════════════

  describe("disconnect (§42.3)", () => {
    it("revokes at Google, clears the sealed tokens, keeps the row, records it, and leaves attachments in place", async () => {
      await connectOk(member);
      const at = await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_1 });
      expect(at.statusCode, at.body).toBe(201);
      const connId = (await rowOf(member)).id;
      fx.seen.length = 0;

      const r = await disconnect(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({ disconnected: true, revokedAtGoogle: true });

      // Google was told, with the long-lived credential and Google's documented bare `token=` body.
      expect(calls("revoke")).toHaveLength(1);
      expect(calls("revoke")[0].url).toBe("https://oauth2.googleapis.com/revoke");
      expect(calls("revoke")[0].form).toEqual({ token: REFRESH_1 });

      const row = await rowOf(member);
      expect(row).toMatchObject({ id: connId, status: "revoked", access_token_enc: null, refresh_token_enc: null, token_expires_at: null, token_key_version: null });
      expect(json(await picker(member))).toMatchObject({ configured: true, connected: false, accessToken: null });

      const act = await activityRows("disconnected", connId);
      expect(act).toHaveLength(1);
      expect(act[0].metadata).toMatchObject({ provider: "google_drive", revokedAtGoogle: true });

      // The link is a link: still attached, still readable.
      expect(await filesOn(taskA)).toHaveLength(1);

      // And the person can connect again into the same row.
      await connectOk(member);
      expect(await rowCount(member)).toBe(1);
      expect((await rowOf(member)).id).toBe(connId);
    });

    it("Google's revoke endpoint failing does not stop the local clear, and the result says so", async () => {
      await connectOk(member);
      fx.revoke = "down";
      const r = await disconnect(member);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({ disconnected: true, revokedAtGoogle: false });
      const row = await rowOf(member);
      expect(row).toMatchObject({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
      expect((await activityRows("disconnected", row.id))[0].metadata).toMatchObject({ provider: "google_drive", revokedAtGoogle: false });
    });

    it("with nothing to clear it says so and calls nobody; and it only ever acts on the CALLER's own row", async () => {
      const none = await disconnect(member);
      expect(none.statusCode).toBe(200);
      expect(json(none)).toEqual({ disconnected: false, revokedAtGoogle: null });
      expect(fx.seen).toEqual([]);

      await connectOk(member);
      fx.email = "lee@gmail.test";
      await connectOk(mgr);
      await disconnect(mgr);
      expect(await rowOf(mgr)).toMatchObject({ status: "revoked" });
      expect(await rowOf(member)).toMatchObject({ status: "linked" }); // untouched
      expect((await disconnect(stranger)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════ attach ═══════════════════════════════════════════════

  describe("attach (§42.5)", () => {
    const body = (over: Record<string, unknown> = {}) => ({ targetType: "task", targetId: taskA, fileId: FILE_1, ...over });
    const driveCalls = () => calls("drive").length;

    it("reads the file from Drive with the person's own token and writes the reference row with DRIVE's name, type and link", async () => {
      await connectOk(member);
      fx.seen.length = 0;
      const before = await fileCount();
      // The browser also tries to dictate the name and link: they are ignored, Drive is the source of truth.
      const r = await attach(member, body({ filename: "HACKED.exe", url: "https://evil.example/x", contentType: "text/html", name: "x" }));
      expect(r.statusCode, r.body).toBe(201);

      expect(calls("drive")).toHaveLength(1);
      expect(calls("drive")[0].url).toBe(`https://www.googleapis.com/drive/v3/files/${FILE_1}?fields=id,name,mimeType,webViewLink`);
      expect(calls("drive")[0].auth).toBe(`Bearer ${ACCESS_1}`);

      const row = json(r);
      expect(row).toMatchObject({
        filename: "Brand brief.pdf", content_type: "application/pdf", byte_size: 0, scrubbed: false, uploader_id: member,
        url: DRIVE_FILES[FILE_1].webViewLink, target_entity_type: "task", target_entity_id: taskA,
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof row.created_at).toBe("string");

      const stored = await filesOn(taskA);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: row.id, tenant_id: A, uploader_id: member, target_entity_type: "task", target_entity_id: taskA, filename: "Brand brief.pdf",
        content_type: "application/pdf", byte_size: "0", storage_key: null, url: DRIVE_FILES[FILE_1].webViewLink, scrubbed: false,
      });
      expect(await fileCount()).toBe(before + 1);

      // The same `attached` activity row POST /files writes, plus where it came from. No token.
      const act = (await activityRows("attached", taskA)).filter((a) => a.metadata.fileId === row.id);
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ actor_id: member, target_entity_type: "task" });
      expect(act[0].metadata).toMatchObject({ fileId: row.id, filename: "Brand brief.pdf", source: "google_drive", driveFileId: FILE_1 });

      // And it is an ordinary attachment to everything else: listed by GET /files.
      const list = await call("GET", `/api/${A}/files?entityType=task&entityId=${taskA}`, member);
      expect(list.statusCode, list.body).toBe(200);
      expect((list.json() as Array<{ id: string; filename: string }>).map((f) => f.filename)).toEqual(["Brand brief.pdf"]);
    });

    it("takes a Google Doc's own type and link too", async () => {
      await connectOk(member);
      const r = await attach(member, body({ fileId: FILE_2 }));
      expect(r.statusCode, r.body).toBe(201);
      expect(json(r)).toMatchObject({ filename: "Launch plan", content_type: "application/vnd.google-apps.document", url: DRIVE_FILES[FILE_2].webViewLink });
    });

    it("the same Drive file on the same task twice answers 409 drive_already_attached and writes nothing; another task, or after a delete, is fine", async () => {
      await connectOk(member);
      expect((await attach(member, body())).statusCode).toBe(201);
      const dup = await attach(member, body());
      expect(dup.statusCode, dup.body).toBe(409);
      expect(reasonOf(dup)).toBe("drive_already_attached");
      expect(errorOf(dup).startsWith("drive_already_attached:")).toBe(true);
      expect(await filesOn(taskA)).toHaveLength(1);

      // Two at once cannot both pass (the check and the write share one advisory lock).
      const race = await Promise.all([attach(member, body({ fileId: FILE_2 })), attach(member, body({ fileId: FILE_2 }))]);
      expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await filesOn(taskA)).toHaveLength(2);

      expect((await attach(member, body({ targetId: taskA2 }))).statusCode).toBe(201);
      expect(await filesOn(taskA2)).toHaveLength(1);

      await q().query(`UPDATE files SET deleted_at = now() WHERE target_entity_id = $1 AND filename = 'Brand brief.pdf'`, [taskA]);
      expect((await attach(member, body())).statusCode).toBe(201);
    });

    it("a file this account cannot reach answers 404 drive_file_not_found and writes nothing", async () => {
      await connectOk(member);
      const r = await attach(member, body({ fileId: FILE_GONE }));
      expect(r.statusCode, r.body).toBe(404);
      expect(reasonOf(r)).toBe("drive_file_not_found");
      expect(errorOf(r).startsWith("drive_file_not_found:")).toBe(true);
      expect(await filesOn(taskA)).toEqual([]);
      expect(await rowOf(member)).toMatchObject({ status: "linked" }); // a missing file is not a broken connection
    });

    it("a Drive outage answers 502 drive_unavailable, once, and writes nothing", async () => {
      await connectOk(member);
      fx.seen.length = 0;
      fx.drive = "down";
      const r = await attach(member, body());
      expect(r.statusCode, r.body).toBe(502);
      expect(reasonOf(r)).toBe("drive_unavailable");
      expect(driveCalls()).toBe(1);
      expect(await filesOn(taskA)).toEqual([]);
      expect(await rowOf(member)).toMatchObject({ status: "linked" });
    });

    it("a token Drive refuses earns ONE forced refresh and ONE retry, and then succeeds", async () => {
      await connectOk(member);
      fx.seen.length = 0;
      fx.validAccess.delete(ACCESS_1); // revoked or rotated on Google's side since we stored it
      const r = await attach(member, body());
      expect(r.statusCode, r.body).toBe(201);
      expect(calls("refresh")).toHaveLength(1);
      expect(driveCalls()).toBe(2);
      expect(calls("drive")[0].auth).toBe(`Bearer ${ACCESS_1}`);
      expect(calls("drive")[1].auth).toMatch(/^Bearer ya29\.DRIVE-REFRESHED-/);
      expect(await rowOf(member)).toMatchObject({ status: "linked" });
    });

    it("a token Drive still refuses after the refresh, or a refresh Google refuses: 409 drive_needs_reconnect, row marked, nothing written", async () => {
      await connectOk(member);
      fx.driveRejectsAll = true;
      const r = await attach(member, body());
      expect(r.statusCode, r.body).toBe(409);
      expect(reasonOf(r)).toBe("drive_needs_reconnect");
      expect(errorOf(r).startsWith("drive_needs_reconnect:")).toBe(true);
      expect(await rowOf(member)).toMatchObject({ status: "error" });
      expect((await rowOf(member)).meta.driveNeedsReconnect).toBe(true);
      expect(await filesOn(taskA)).toEqual([]);

      // Now marked: the next attach does not even call Google.
      fx.seen.length = 0;
      const again = await attach(member, body());
      expect(again.statusCode).toBe(409);
      expect(reasonOf(again)).toBe("drive_needs_reconnect");
      expect(fx.seen).toEqual([]);

      // Same answer when the forced refresh itself is refused.
      await connectOk(member);
      fx.driveRejectsAll = false;
      fx.validAccess.delete(ACCESS_1);
      fx.refresh = "invalid_grant";
      const refused = await attach(member, body());
      expect(refused.statusCode).toBe(409);
      expect(reasonOf(refused)).toBe("drive_needs_reconnect");
      expect((await rowOf(member)).meta.driveNeedsReconnect).toBe(true);
    });

    it("no connection yet: 409 drive_not_connected, and Google is not called", async () => {
      const r = await attach(member, body());
      expect(r.statusCode, r.body).toBe(409);
      expect(reasonOf(r)).toBe("drive_not_connected");
      expect(fx.seen).toEqual([]);
      // Someone ELSE'S connection never serves this person.
      await connectOk(mgr);
      fx.seen.length = 0;
      expect(reasonOf(await attach(member, body()))).toBe("drive_not_connected");
      expect(fx.seen).toEqual([]);
    });

    describe("authorise first, exactly as POST /files, and validate after", () => {
      it("a caller refused `file` · `create` or `read` on the task gets 403 even with a bad body, and Google is never called", async () => {
        await connectOk(member);
        fx.seen.length = 0;
        const before = await fileCount();
        // `stranger`: not in the company at all. `viewer`: may read files and tasks, may NOT create a file.
        for (const who of [stranger, viewer]) {
          for (const bad of [{}, { targetType: "project" }, { targetType: "task" }, { targetType: "task", targetId: taskA, fileId: "../etc" }, body(), body({ targetId: "not-a-uuid" })]) {
            const r = await attach(who, bad);
            expect(r.statusCode, `${who === stranger ? "stranger" : "viewer"} ${JSON.stringify(bad)}`).toBe(403);
          }
        }
        expect(fx.seen).toEqual([]);
        expect(await fileCount()).toBe(before);
      });

      it("another tenant's task answers 404 target_not_found, with no Drive call and no row in either tenant", async () => {
        await connectOk(mgr);
        fx.seen.length = 0;
        const before = await fileCount();
        const r = await attach(mgr, body({ targetId: taskB }));
        expect(r.statusCode, r.body).toBe(404);
        expect(reasonOf(r)).toBe("target_not_found");
        // And the same task through ITS OWN tenant's route, by someone who is not in that company: refused outright.
        expect((await attach(mgr, body({ targetId: taskB }), B)).statusCode).toBe(403);
        expect(fx.seen).toEqual([]);
        expect(await fileCount()).toBe(before);
      });

      it("only after authorisation: an unsupported targetType is 400, an unknown task 404, a bad file id 400; Google not called", async () => {
        await connectOk(member);
        fx.seen.length = 0;
        const t = await attach(member, body({ targetType: "project" }));
        expect(t.statusCode).toBe(400);
        expect(reasonOf(t)).toBe("unsupported_target_type");
        expect((await attach(member, body({ targetType: undefined }))).statusCode).toBe(400);

        for (const targetId of [undefined, "", "not-a-uuid", "00000000-0000-4000-8000-000000000000", 7]) {
          const r = await attach(member, body({ targetId }));
          expect(r.statusCode, String(targetId)).toBe(404);
          expect(reasonOf(r)).toBe("target_not_found");
        }
        for (const fileId of [undefined, "", "abc", "a/b/c/d/e/f", "x?fields=all&y", 12345, "x".repeat(300)]) {
          const r = await attach(member, body({ fileId }));
          expect(r.statusCode, String(fileId)).toBe(400);
          expect(reasonOf(r)).toBe("bad_drive_file_id");
        }
        expect(fx.seen).toEqual([]);
        expect(await filesOn(taskA)).toEqual([]);
      });

      it("a plain member and a manager can both attach to a task in their company", async () => {
        await connectOk(member);
        fx.email = "lee@gmail.test";
        await connectOk(mgr);
        expect((await attach(member, body())).statusCode).toBe(201);
        expect((await attach(mgr, body({ fileId: FILE_2 }))).statusCode).toBe(201);
        expect((await filesOn(taskA)).map((f) => f.uploader_id).sort()).toEqual([member, mgr].sort());
      });
    });
  });

  // ═══════════════════════════════════════════════ the secret rule ═══════════════════════════════════════════════

  describe("the secret rule (§42.7: a token never appears outside the Picker's answer)", () => {
    it("connects, picks, refreshes, attaches, fails and disconnects, then scans every response and every table it wrote", async () => {
      // A full run that touches every route and many failure branches, with these sentinels as the credentials.
      await connectOk(member);
      await picker(member);
      await expireIn(member, "1 minute");
      fx.rotate = true;
      await picker(member);
      await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_1 });
      await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_1 });
      await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_GONE });
      fx.drive = "down";
      await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_2 });
      fx.drive = "ok";
      await attach(stranger, {});
      fx.exchange = "refused";
      await connect(mgr);
      fx.exchange = "ok";
      fx.refresh = "invalid_grant";
      await expireIn(member, "1 minute");
      await picker(member);
      await attach(member, { targetType: "task", targetId: taskA, fileId: FILE_2 });
      await call("GET", `/api/${A}/integrations/connections?owner=me&provider=google_drive`, member);
      await call("GET", `/api/${A}/files?entityType=task&entityId=${taskA}`, member);
      fx.refresh = "ok";
      await disconnect(member);
      await disconnect(member);

      const refreshed = [...fx.validAccess].filter((t) => t !== ACCESS_1);
      const accessTokens = [ACCESS_1, ...refreshed, "ya29."];
      const never = [REFRESH_1, REFRESH_2, "1//DRIVE-REFRESH", CLIENT_SECRET, CODE, "eyJhbGciOiJSUzI1NiIs", ...fx.idTokens];

      // 1. Responses: no refresh token, ID token, code or client secret anywhere; an ACCESS token only in a Picker answer.
      expect(wire.length).toBeGreaterThan(20);
      for (const w of wire) {
        for (const s of never) expect(w.text, `${w.label} must not contain ${s.slice(0, 12)}…`).not.toContain(s);
        if (!w.picker) for (const s of accessTokens) expect(w.text, `${w.label} must not contain an access token`).not.toContain(s);
      }
      expect(wire.some((w) => w.picker && w.text.includes(ACCESS_1))).toBe(true); // the one place it is meant to be

      // 2. Everything it wrote: activities, events, connection rows, state rows, file rows.
      const dump = async (sql: string, params: unknown[] = []) => JSON.stringify((await q().query(sql, params)).rows);
      const tables = {
        activities: await dump(`SELECT to_jsonb(a) FROM activities a WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]),
        events: await dump(`SELECT payload FROM outbox_events WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]),
        files: await dump(`SELECT to_jsonb(f) FROM files f WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]),
        states: await dump(`SELECT to_jsonb(s) FROM google_oauth_states s WHERE provider = 'google_drive'`),
        connectionsNonSecret: await dump(
          `SELECT id, tenant_id, owner_kind, owner_id, provider, external_account, scopes, status, meta, token_key_version FROM integration_connections WHERE provider = 'google_drive'`,
        ),
      };
      for (const [name, text] of Object.entries(tables)) {
        // A scan of nothing proves nothing: the tables this run certainly wrote must be non-empty.
        if (["activities", "states", "connectionsNonSecret", "files"].includes(name)) expect(text.length, name).toBeGreaterThan(2);
        for (const s of [...never, ...accessTokens]) expect(text, `${name} must not contain ${s.slice(0, 12)}…`).not.toContain(s);
      }

      // 3. The vault columns hold only sealed envelopes, never a bare token.
      const sealed = (await q().query(`SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE provider = 'google_drive'`)).rows;
      for (const r of sealed) {
        for (const col of [r.access_token_enc, r.refresh_token_enc]) if (col) expect(String(col).startsWith("enc:v1:")).toBe(true);
      }
    });

    it("the connections list shows only that a credential exists (hasToken), never the credential", async () => {
      await connectOk(member);
      const r = await call("GET", `/api/${A}/integrations/connections?owner=me&provider=google_drive`, member);
      expect(r.statusCode, r.body).toBe(200);
      const rows = r.json() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: "google_drive", status: "linked", hasToken: true, hasRefreshToken: true, externalAccount: "dana@gmail.test" });
      expect(Object.keys(rows[0]).some((k) => /enc$|token$/i.test(k) && !/^(hasToken|hasRefreshToken|tokenExpiresAt|tokenKeyVersion)$/.test(k))).toBe(false);
    });
  });
});
