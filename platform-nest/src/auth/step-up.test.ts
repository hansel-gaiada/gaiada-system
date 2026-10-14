// PV5-14 / owner ruling PV-D40 — the SIMULATED second factor, driven over the REAL HTTP surface (Postgres + RLS +
// Cerbos + Redis; the Linux gate; skips without DATABASE_URL_TEST / REDIS_URL / CERBOS_URL, and a skipped run
// proves nothing). Sessions are real OIDC bearer tokens signed by an in-test key (the oidc.test.ts seam), each
// carrying a Keycloak-style `sid`, so the session binding is exercised exactly as live would.
//
// What it pins (the PV5-14 ticket's test list):
//   * flag off: both routes 404 (even unauthenticated), /api/me stays `linked`, a high-assurance refusal carries no
//     `reason` (identical to before);
//   * flag on: a staff session goes linked -> high (`assuranceSource: "simulated"`), the `auth.step_up_simulated`
//     activity row is written, `[auth:mfa-simulated]` is logged once; `finance_tax` configure and `set_bank_details`
//     are denied (403 `assurance_required`) before and allowed after;
//   * the step-up is bound to THIS session: another session of the same user stays `linked`;
//   * it falls back after 15 minutes (clock seam), and the moment the flag goes off;
//   * a client, a bot, an agent envelope, a D14-style re-drive envelope and the dev header are all refused;
//   * a real second factor (`amr`) is untouched and has nothing to simulate.
//
// TEETH (each run as its own gate after the green one; see the PV5-14 hand-back):
//   (a) ignore the flag in applySimulatedStepUp -> "the moment the flag goes off, the session is linked again" fails;
//   (b) drop the session binding (sessionRefFor hashes the user only) -> "another session ... stays linked" fails;
//   (c) drop the bot/client refusal in eligibility() -> "a bot ..." and "a client ..." fail.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { config } from "../config";
import { withGlobal, withTenants, newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../testing/fixtures";
import { setJwksForTest } from "./oidc";
import { STEP_UP_TTL_MS, setStepUpClockForTest } from "./step-up";
import { closeRedis } from "../events/redis";

const ready = !!TEST_URL && !!process.env.REDIS_URL && !!process.env.CERBOS_URL;
const SVC = "svc-token-pv514";

let privateKey: CryptoKey;
async function token(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.oidcIssuer)
    .setAudience(config.oidcAudience)
    .setIssuedAt()
    .setSubject(String(claims.sub))
    .setExpirationTime("1h")
    .sign(privateKey);
}

describe.skipIf(!ready)("PV5-14 — simulated second factor (PV-D40)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let staff: string;     // finance_manager: may configure tax codes and set bank details, at HIGH assurance only
  let clientUser: string; // users.kind = 'client', a client contact (and, deliberately, also a member)
  let botUser: string;    // users.kind = 'bot', a member holding finance_manager
  let staffA: string;     // the staff member's session A (sid sess-A)
  let staffB: string;     // the SAME user's session B (sid sess-B)
  let staffNoSid: string; // the same user, a token naming no session
  let staffMfa: string;   // the same user, a REAL second factor (amr otp)
  let clientTok: string;
  let botTok: string;
  const origAuthMode = config.authMode;
  const origFlag = config.mfaSimulationEnabled;
  const origToken = config.serviceToken;

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const svc = { authorization: `Bearer ${SVC}` };
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
  const simulate = (headers: Record<string, string>, payload: unknown = { confirm: true }) =>
    app.inject({ method: "POST", url: "/api/auth/step-up/simulate", headers, payload: payload as object });
  const me = async (t: string) => (await get("/api/me", bearer(t))).json() as { assurance: string; assuranceSource?: string; assuranceExpiresAt?: string };
  const configureTax = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: `/api/${tenant}/finance/tax/codes/standard-ppn`, headers, payload: {} });
  const setBank = (headers: Record<string, string>) =>
    app.inject({
      method: "PUT", url: `/api/${tenant}/billing-profile`, headers,
      payload: { bank: { bankName: "Example Bank", accountName: "PV5-14 Example", accountNo: "0000014014" } },
    });
  const stepUpRows = () =>
    withTenants([tenant], (c) =>
      c.query<{ actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = 'auth.step_up_simulated' ORDER BY occurred_at`,
        [tenant],
      ),
    );

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = SVC;
    config.authMode = "hybrid"; // OIDC bearer tokens AND the dev header, so both paths can be driven
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.kid = "pv514";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));

    tenant = await createCompany("PV5-14 Step-up Co", ["finance"]);
    const fm = await createRole("finance_manager");
    staff = await createUser("staff@pv514.test", "PV5-14 Staff");
    await addMembership(tenant, staff);
    await grantRole(staff, fm, "company", tenant);

    clientUser = await createUser("client@pv514.test", "PV5-14 Client");
    await addMembership(tenant, clientUser); // a member too: the KIND must refuse it, not the missing membership
    await grantRole(clientUser, await createRole("client"), "company", tenant);
    await grantRole(clientUser, fm, "company", tenant); // and a staff-side grant: still refused on kind
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [clientUser]));
    const clientRow = await createClient(tenant, "PV5-14 Client Co");
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'admin', 'active', now(), $5)`,
        [newId(), tenant, clientRow, clientUser, config.originSite],
      ));

    botUser = await createUser("bot@pv514.test", "PV5-14 Bot");
    await addMembership(tenant, botUser);
    await grantRole(botUser, fm, "company", tenant);
    // PV5-10 review: an IdP login may no longer CLAIM a bot or automation account by email (oidc.ts provisionUser), so
    // the bot's IdP subject is linked here, as an operator would link one; the step-up refusal under test is unchanged.
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'bot', idp_subject = 'kc-pv514-bot' WHERE id = $1`, [botUser]));

    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1,'IDR','IDR')`, [tenant]);
      await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [tenant]);
    }, { modules: ["finance"] });

    // Live's shape: no `amr` at all (Keycloak emits none), a `sid` naming the IdP session.
    const staffClaims = { sub: "kc-pv514-staff", email: "staff@pv514.test", email_verified: true, name: "PV5-14 Staff" };
    staffA = await token({ ...staffClaims, sid: "sess-A" });
    staffB = await token({ ...staffClaims, sid: "sess-B" });
    staffNoSid = await token({ ...staffClaims });
    staffMfa = await token({ ...staffClaims, sid: "sess-M", amr: ["pwd", "otp"] });
    clientTok = await token({ sub: "kc-pv514-client", email: "client@pv514.test", email_verified: true, sid: "sess-C" });
    botTok = await token({ sub: "kc-pv514-bot", email: "bot@pv514.test", email_verified: true, sid: "sess-BOT" });

    app = await buildApp();

    // The billing profile must exist before a bank-only PUT can succeed (created over the dev header, at high).
    const created = await app.inject({
      method: "PUT", url: `/api/${tenant}/billing-profile`, headers: { ...svc, "x-user-id": staff },
      payload: { legalName: "PV5-14 Example", address: "Example street 14", invoicePrefix: "PVF" },
    });
    expect(created.statusCode, created.body).toBe(200);
    vi.spyOn(console, "error").mockImplementation(() => {}); // `[oidc:amr-claim-missing]` on every live-shaped token
    config.mfaSimulationEnabled = true; // each test that needs it OFF says so; afterEach turns it back on
  }, 180_000);

  afterEach(() => {
    setStepUpClockForTest(null);
    config.mfaSimulationEnabled = true;
  });

  afterAll(async () => {
    config.authMode = origAuthMode;
    config.mfaSimulationEnabled = origFlag;
    config.serviceToken = origToken;
    setStepUpClockForTest(null);
    vi.restoreAllMocks();
    await app?.close();
    await closeRedis().catch(() => undefined);
    await teardownTestDb();
  });

  describe("flag OFF: behaviour identical to before", () => {
    it("both routes 404, for a signed-in staff session and for an unauthenticated caller alike", async () => {
      config.mfaSimulationEnabled = false;
      expect((await get("/api/auth/step-up", bearer(staffA))).statusCode).toBe(404);
      expect((await simulate(bearer(staffA))).statusCode).toBe(404);
      expect((await simulate({})).statusCode).toBe(404);
      expect((await get("/api/auth/step-up", {})).statusCode).toBe(404);
    });

    it("the session stays linked, and a high-assurance refusal says exactly what it said before (no reason)", async () => {
      config.mfaSimulationEnabled = false;
      const m = await me(staffA);
      expect(m.assurance).toBe("linked");
      expect(m.assuranceSource).toBeUndefined();
      const r = await configureTax(bearer(staffA));
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "not authorized: cerbos denied configure on finance_tax" });
    });
  });

  describe("flag ON: a staff session steps up, bound to itself, for 15 minutes", () => {
    it("before: GET says available, not active; tax configure and set_bank_details are refused as assurance_required", async () => {
      const s = await get("/api/auth/step-up", bearer(staffA));
      expect(s.statusCode, s.body).toBe(200);
      expect(s.json()).toEqual({ available: true, active: false, simulated: false, expiresAt: null, assurance: "linked", ttlSeconds: 900 });
      const tax = await configureTax(bearer(staffA));
      expect(tax.statusCode).toBe(403);
      expect(tax.json()).toMatchObject({ reason: "assurance_required" });
      expect(tax.json().error).toContain("needs a second factor");
      const bank = await setBank(bearer(staffA));
      expect(bank.statusCode).toBe(403);
      expect(bank.json()).toMatchObject({ reason: "assurance_required" });
    });

    it("authorization before validation: a missing confirm is a 400 on `confirm`, and records nothing", async () => {
      const r = await simulate(bearer(staffA), {});
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ field: "confirm" });
      expect((await me(staffA)).assurance).toBe("linked");
      expect((await stepUpRows()).rows).toHaveLength(0);
    });

    it("simulate: 200, the session reaches high (assuranceSource simulated), audited once, logged once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = Date.now();
      const r = await simulate(bearer(staffA));
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as { active: boolean; simulated: boolean; expiresAt: string; assurance: string; assuranceSource: string };
      expect(body).toMatchObject({ active: true, simulated: true, assurance: "high", assuranceSource: "simulated" });
      const exp = Date.parse(body.expiresAt);
      expect(exp).toBeGreaterThanOrEqual(before + STEP_UP_TTL_MS - 5_000);
      expect(exp).toBeLessThanOrEqual(Date.now() + STEP_UP_TTL_MS + 5_000);

      const logged = warn.mock.calls.filter((c) => String(c[0]).includes("[auth:mfa-simulated]"));
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).toContain(`user=${staff}`);
      warn.mockRestore();

      const rows = (await stepUpRows()).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(staff);
      expect(rows[0].metadata).toMatchObject({ simulated: true, assuranceSource: "simulated", expiresAt: body.expiresAt, ttlSeconds: 900, ruling: "PV-D40" });
      expect(JSON.stringify(rows[0].metadata)).not.toContain("sess-A"); // the raw IdP session id is never stored

      const m = await me(staffA);
      expect(m).toMatchObject({ assurance: "high", assuranceSource: "simulated", assuranceExpiresAt: body.expiresAt });
      const s = (await get("/api/auth/step-up", bearer(staffA))).json();
      expect(s).toEqual({ available: true, active: true, simulated: true, expiresAt: body.expiresAt, assurance: "high", ttlSeconds: 900 });
    });

    it("after: the same high-assurance actions are ALLOWED for this session (finance_tax configure, set_bank_details)", async () => {
      const tax = await configureTax(bearer(staffA));
      expect(tax.statusCode, tax.body).toBe(200);
      const bank = await setBank(bearer(staffA));
      expect(bank.statusCode, bank.body).toBe(200);
    });

    it("★ another session of the SAME user is NOT stepped up (session binding)", async () => {
      expect((await me(staffB)).assurance).toBe("linked");
      const tax = await configureTax(bearer(staffB));
      expect(tax.statusCode).toBe(403);
      expect(tax.json()).toMatchObject({ reason: "assurance_required" });
      expect((await get("/api/auth/step-up", bearer(staffB))).json()).toMatchObject({ available: true, active: false });
    });

    it("a token that names no IdP session cannot be stepped up (409 session_unbound) and is never raised", async () => {
      const r = await simulate(bearer(staffNoSid));
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "session_unbound" });
      expect((await me(staffNoSid)).assurance).toBe("linked");
      expect((await get("/api/auth/step-up", bearer(staffNoSid))).json()).toMatchObject({ available: false, reason: "session_unbound" });
    });

    it("★ it falls back to linked once 15 minutes have passed", async () => {
      setStepUpClockForTest(() => Date.now() + STEP_UP_TTL_MS - 60_000);
      expect((await me(staffA)).assurance).toBe("high"); // 14 minutes in: still held
      setStepUpClockForTest(() => Date.now() + STEP_UP_TTL_MS + 1_000);
      const m = await me(staffA);
      expect(m.assurance).toBe("linked");
      expect(m.assuranceSource).toBeUndefined();
      expect((await configureTax(bearer(staffA))).statusCode).toBe(403);
    });

    it("★ the moment the flag goes off, the session is linked again (no lingering step-up)", async () => {
      expect((await me(staffA)).assurance).toBe("high");
      config.mfaSimulationEnabled = false;
      expect((await me(staffA)).assurance).toBe("linked");
      const tax = await configureTax(bearer(staffA));
      expect(tax.statusCode).toBe(403);
      expect(tax.json().reason).toBeUndefined();
    });

    it("simulating again restarts the 15 minutes and writes another audit row", async () => {
      const r = await simulate(bearer(staffA));
      expect(r.statusCode, r.body).toBe(200);
      expect((await stepUpRows()).rows).toHaveLength(2);
    });
  });

  describe("who can never simulate", () => {
    it("★ a client (portal) principal: 403 step_up_staff_only, and stays linked", async () => {
      const r = await simulate(bearer(clientTok));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ reason: "step_up_staff_only" });
      expect((await me(clientTok)).assurance).toBe("linked");
      expect((await get("/api/auth/step-up", bearer(clientTok))).json()).toMatchObject({ available: false, reason: "step_up_staff_only" });
    });

    it("★ a bot account: 403 step_up_not_for_automation, and stays linked", async () => {
      const r = await simulate(bearer(botTok));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ reason: "step_up_not_for_automation" });
      expect((await me(botTok)).assurance).toBe("linked");
    });

    it("an automation account: 403 step_up_not_for_automation", async () => {
      await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [botUser]));
      try {
        const r = await simulate(bearer(botTok));
        expect(r.statusCode).toBe(403);
        expect(r.json()).toMatchObject({ reason: "step_up_not_for_automation" });
      } finally {
        await withGlobal((c) => c.query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botUser]));
      }
    });

    it("★ an agent driving the human's envelope, and a D14-style re-drive as the original filer: refused, and never inherit the human's step-up", async () => {
      // The human holds an ACTIVE simulated step-up on session A (from the test above).
      expect((await me(staffA)).assurance).toBe("high");
      await linkIdentity(staff, "whatsapp", "+62-pv514", true);
      const envelope = { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "+62-pv514" };
      for (const headers of [{ ...envelope, "x-obo-agent": "agent-pv514" }, envelope]) {
        const r = await simulate(headers);
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json()).toMatchObject({ reason: "step_up_interactive_only" });
        const tax = await configureTax(headers);
        expect(tax.statusCode).toBe(403); // the envelope assembles at linked: the human's step-up is not carried
        expect(tax.json().reason).toBeUndefined(); // and no step-up hint is offered to a non-interactive caller
      }
    });

    it("the dev header path (service token + x-user-id) is not an interactive session: refused", async () => {
      const r = await simulate({ ...svc, "x-user-id": staff });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ reason: "step_up_interactive_only" });
    });

    it("a REAL second factor (amr otp) is untouched: high without assuranceSource, and nothing to simulate (409)", async () => {
      const m = await me(staffMfa);
      expect(m.assurance).toBe("high");
      expect(m.assuranceSource).toBeUndefined();
      const r = await simulate(bearer(staffMfa));
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "already_high_assurance" });
      expect((await get("/api/auth/step-up", bearer(staffMfa))).json()).toMatchObject({ available: false, active: true, simulated: false });
    });

    it("unauthenticated: 401 when the flag is on", async () => {
      expect((await simulate({})).statusCode).toBe(401);
    });
  });
});
