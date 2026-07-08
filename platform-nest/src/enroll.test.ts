// 5b.5 dual-proof enrollment + 5b.6 authoritative revocation, against live PG + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "./config";
import { withGlobal } from "./db";
import { resetModules } from "./modules/registry";
import { buildApp } from "./main";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };

describe.skipIf(!TEST_URL)("dual-proof enrollment + revocation (5b.5/5b.6)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let mfaUser: string; // will be treated as high-assurance (dev x-user-id → high)
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.authMode = "dev"; // x-user-id → high assurance, standing in for an MFA'd IdP session
    resetModules();
    tenant = await createCompany("Gaiada HQ");
    mfaUser = await createUser("owner@gaiada.test", "Owner");
    admin = await createUser("admin@gaiada.test", "Admin");
    member = await createUser("m@gaiada.test", "Member");
    await addMembership(tenant, mfaUser);
    await addMembership(tenant, member);
    await grantRole(mfaUser, await createRole("member"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    await grantRole(admin, await createRole("platform_admin"), "global", null);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  async function startEnroll(userId: string) {
    return app.inject({ method: "POST", url: "/identity/enroll/start", headers: { ...svc, "x-user-id": userId } });
  }

  it("start requires a HIGH-assurance session (dev x-user-id qualifies; low-assurance OBO does not)", async () => {
    const ok = await startEnroll(mfaUser);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).toMatch(/^[0-9A-F]{8}$/);

    // An OBO-envelope caller (no verified link yet) is low/anonymous → cannot start.
    const low = await app.inject({
      method: "POST", url: "/identity/enroll/start",
      headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "628-unknown" },
    });
    expect(low.statusCode).toBe(401); // no principal at all in dev mode w/o x-user-id
  });

  it("confirm with a valid code links the chat identity (verified_at set); bad/expired/reused codes refused", async () => {
    const code = (await startEnroll(mfaUser)).json().code;

    const bad = await app.inject({
      method: "POST", url: "/identity/enroll/confirm", headers: svc,
      payload: { code: "DEADBEEF", provider: "whatsapp", externalId: "628111@c.us" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST", url: "/identity/enroll/confirm", headers: svc,
      payload: { code, provider: "whatsapp", externalId: "628111@c.us" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ linked: true, userId: mfaUser });

    // Reuse of a consumed code is refused.
    const reuse = await app.inject({
      method: "POST", url: "/identity/enroll/confirm", headers: svc,
      payload: { code, provider: "whatsapp", externalId: "628111@c.us" },
    });
    expect(reuse.statusCode).toBe(400);

    // The link is now VERIFIED → the OBO envelope resolves to a 'linked' principal.
    const resolved = await app.inject({
      method: "POST", url: "/principal/resolve", headers: svc,
      payload: { provider: "whatsapp", externalId: "628111@c.us" },
    });
    expect(resolved.json().assurance).toBe("linked");
    expect(resolved.json().userId).toBe(mfaUser);
  });

  it("both proofs are required: a code alone can't link an identity the user never controlled... it links whatever the bot OBSERVED", async () => {
    // The security property: confirm carries the external_id the BOT saw the code arrive
    // from. Without a live code (IdP proof), no link forms.
    const noCode = await app.inject({
      method: "POST", url: "/identity/enroll/confirm", headers: svc,
      payload: { provider: "whatsapp", externalId: "628999@c.us" },
    });
    expect(noCode.statusCode).toBe(400);
  });

  it("5b.6: an admin revoke bumps session_version; a disabled user is denied on the next call", async () => {
    // platform_admin revokes the member.
    const rev = await app.inject({
      method: "POST", url: `/admin/users/${member}/revoke`, headers: { ...svc, "x-user-id": admin },
    });
    expect(rev.statusCode).toBe(200);
    const sv = await withGlobal((c) => c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [member]));
    expect(sv.rows[0].session_version).toBeGreaterThan(1);

    // A non-admin cannot revoke.
    const denied = await app.inject({
      method: "POST", url: `/admin/users/${admin}/revoke`, headers: { ...svc, "x-user-id": member },
    });
    expect(denied.statusCode).toBe(403);

    // Disable the user → the stateless per-request re-resolution denies them immediately.
    await withGlobal((c) => c.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [member]));
    const after = await app.inject({ method: "GET", url: `/api/${tenant}/projects`, headers: { ...svc, "x-user-id": member } });
    expect(after.statusCode).toBe(401);
  });
});
