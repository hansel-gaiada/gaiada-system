// Phase-5b e2e (5b.8): the identity+authz stack whole — a REAL signed IdP token
// (AUTH_MODE=oidc, in-test JWK) → auto-provision → Cerbos-authorized read → dual-proof
// enrollment of a chat identity → the linked identity reads via OBO → admin revocation
// cuts the user off on the next call. Needs live Postgres + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { config } from "./config";
import { withGlobal, withTenants, newId } from "./db";
import { resetModules } from "./modules/registry";
import { setJwksForTest } from "./auth/oidc";
import { buildApp } from "./main";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createRole, grantRole, addMembership } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const cerbosLive = Boolean(process.env.CERBOS_URL);
let privateKey: CryptoKey;

async function idToken(sub: string, email: string, mfa: boolean) {
  return new SignJWT({ email, email_verified: true, name: email, amr: mfa ? ["pwd", "otp"] : ["pwd"] })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.oidcIssuer)
    .setAudience(config.oidcAudience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe.skipIf(!TEST_URL || !cerbosLive)("phase 5b e2e: OIDC → Cerbos → enrollment → revocation", () => {
  let app: NestFastifyApplication;
  let tenant: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.authMode = "oidc";
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.kid = "e2e";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));
    resetModules();
    tenant = await createCompany("Gaiada HQ");
    app = await buildApp();
  });
  afterAll(async () => {
    config.authMode = "dev";
    await app.close();
    await teardownTestDb();
  });

  it("runs the whole identity+authz flow end to end", async () => {
    // 1. First OIDC login (MFA'd) auto-provisions the user.
    const bearer = { authorization: `Bearer ${await idToken("kc-e2e", "lead@gaiada.test", true)}` };
    const me = await app.inject({ method: "GET", url: "/api/me", headers: bearer });
    expect(me.statusCode).toBe(200);
    const userId = me.json().userId as string;
    expect(userId).toBeTruthy();

    // 2. Give them a company role, then Cerbos authorizes an in-tenant read.
    await addMembership(tenant, userId);
    await grantRole(userId, await createRole("manager"), "company", tenant);
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1,$2,'Alpha','main')`, [newId(), tenant]),
    );
    const projects = await app.inject({ method: "GET", url: `/api/${tenant}/projects`, headers: bearer });
    expect(projects.statusCode).toBe(200);
    expect((projects.json() as unknown[]).length).toBe(1);

    // 3. Dual-proof enrollment: MFA session starts, "bot" confirms with the code.
    const start = await app.inject({ method: "POST", url: "/identity/enroll/start", headers: bearer });
    expect(start.statusCode).toBe(200);
    const confirm = await app.inject({
      method: "POST", url: "/identity/enroll/confirm", headers: svc,
      payload: { code: start.json().code, provider: "whatsapp", externalId: "62800@c.us" },
    });
    expect(confirm.json()).toMatchObject({ linked: true, userId });

    // 4. The linked chat identity now reads company data via the OBO envelope (linked assurance).
    const viaBot = await app.inject({
      method: "GET", url: `/api/${tenant}/projects`,
      headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "62800@c.us" },
    });
    expect(viaBot.statusCode).toBe(200);

    // 5. Admin revokes + disables → the very next OBO call is denied (D11).
    const admin = newId();
    await withGlobal((c) => c.query(`INSERT INTO users (id, email, name, origin_site) VALUES ($1,'a@gaiada.test','Admin','main')`, [admin]));
    await grantRole(admin, await createRole("platform_admin"), "global", null);
    // (revoke path proven in enroll.test; here assert the disable cutoff via OBO)
    await withGlobal((c) => c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]));
    const afterRevoke = await app.inject({
      method: "GET", url: `/api/${tenant}/projects`,
      headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "62800@c.us" },
    });
    expect(afterRevoke.statusCode).toBe(403); // disabled user → minimal principal → Cerbos denies
  });
});
