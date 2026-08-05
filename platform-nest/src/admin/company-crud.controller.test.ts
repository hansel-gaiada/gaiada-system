// D14-07 (OQ-5) — the retry-policy setting rides through the EXISTING company PATCH rather than a
// new settings table/subsystem (constraint 10). This file pins the write path's contract: it merges
// exactly the `automation.approvalRetry` leaf of the shared `companies.settings` jsonb column
// (0001) and never clobbers a sibling key some other feature already put there, it validates
// `autoRetryCount` to 0..3 (approval-execute.ts's MAX_AUTO_RETRY_COUNT is the read-side twin of this
// write-side check), and it round-trips through the same GET a client would use to render it.
// approval-execute.test.ts's own "(f) autoRetryCount is read fresh" suite proves the EXECUTOR side
// of "no restart needed"; automation-approvals.test.ts's D14-07 retry-endpoint suite proves it via
// the real HTTP write path end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

describe.skipIf(!TEST_URL)("PATCH /api/companies/:companyId — settings.automation.approvalRetry (D14-07/OQ-5)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("D14-07 Settings Co");
    admin = await createUser("d1407-settings-admin@a.test");
    member = await createUser("d1407-settings-member@a.test");
    await addMembership(co, admin);
    await addMembership(co, member);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("defaults to absent (manual-only) until written", async () => {
    const got = await app.inject({ method: "GET", url: `/api/companies/${co}`, headers: asUser(admin) });
    expect(got.statusCode).toBe(200);
    expect(got.json().settings?.automation?.approvalRetry).toBeUndefined();
  });

  it("round-trips through PATCH then GET", async () => {
    const patch = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(admin),
      payload: { settings: { automation: { approvalRetry: { autoRetryCount: 2 } } } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ ok: true });

    const got = await app.inject({ method: "GET", url: `/api/companies/${co}`, headers: asUser(admin) });
    expect(got.statusCode).toBe(200);
    expect(got.json().settings).toMatchObject({ automation: { approvalRetry: { autoRetryCount: 2 } } });
  });

  it("rejects autoRetryCount outside 0..3 and leaves the stored value untouched", async () => {
    // Establish a known-good baseline first.
    await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(admin),
      payload: { settings: { automation: { approvalRetry: { autoRetryCount: 1 } } } },
    });

    for (const bad of [-1, 4, 3.5, "2", null]) {
      const r = await app.inject({
        method: "PATCH", url: `/api/companies/${co}`, headers: asUser(admin),
        payload: { settings: { automation: { approvalRetry: { autoRetryCount: bad } } } },
      });
      expect(r.statusCode).toBe(400);
    }
    const got = await app.inject({ method: "GET", url: `/api/companies/${co}`, headers: asUser(admin) });
    expect(got.json().settings).toMatchObject({ automation: { approvalRetry: { autoRetryCount: 1 } } });
  });

  it("accepts the boundary values 0 and 3", async () => {
    for (const n of [0, 3]) {
      const r = await app.inject({
        method: "PATCH", url: `/api/companies/${co}`, headers: asUser(admin),
        payload: { settings: { automation: { approvalRetry: { autoRetryCount: n } } } },
      });
      expect(r.statusCode).toBe(200);
      const got = await app.inject({ method: "GET", url: `/api/companies/${co}`, headers: asUser(admin) });
      expect(got.json().settings).toMatchObject({ automation: { approvalRetry: { autoRetryCount: n } } });
    }
  });

  it("merges, never overwrites: a pre-existing unrelated settings key AND a sibling automation.* key both survive the write", async () => {
    const co2 = await createCompany("D14-07 Settings Co — merge probe");
    await addMembership(co2, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co2);
    // Seed settings with a key from an unrelated feature AND a sibling key under `automation` that
    // this endpoint must never know about or touch.
    await adminPool().query(
      `UPDATE companies SET settings = $2::jsonb WHERE id = $1`,
      [co2, JSON.stringify({ someOtherFeature: { flag: true }, automation: { someOtherAutomationSetting: "keep-me" } })],
    );

    const patch = await app.inject({
      method: "PATCH", url: `/api/companies/${co2}`, headers: asUser(admin),
      payload: { settings: { automation: { approvalRetry: { autoRetryCount: 1 } } } },
    });
    expect(patch.statusCode).toBe(200);

    const got = await app.inject({ method: "GET", url: `/api/companies/${co2}`, headers: asUser(admin) });
    expect(got.json().settings).toMatchObject({
      someOtherFeature: { flag: true },
      automation: { someOtherAutomationSetting: "keep-me", approvalRetry: { autoRetryCount: 1 } },
    });
  });

  it("omitting `settings` entirely leaves it completely untouched (a plain name/status PATCH is a no-op on settings)", async () => {
    const co3 = await createCompany("D14-07 Settings Co — omission probe");
    await addMembership(co3, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co3);
    await adminPool().query(`UPDATE companies SET settings = $2::jsonb WHERE id = $1`, [co3, JSON.stringify({ automation: { approvalRetry: { autoRetryCount: 2 } } })]);

    const patch = await app.inject({ method: "PATCH", url: `/api/companies/${co3}`, headers: asUser(admin), payload: { name: "Renamed, settings untouched" } });
    expect(patch.statusCode).toBe(200);

    const got = await app.inject({ method: "GET", url: `/api/companies/${co3}`, headers: asUser(admin) });
    expect(got.json()).toMatchObject({ name: "Renamed, settings untouched", settings: { automation: { approvalRetry: { autoRetryCount: 2 } } } });
  });

  it("a plain member cannot write the setting (same 'update' gate as the rest of this PATCH)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(member),
      payload: { settings: { automation: { approvalRetry: { autoRetryCount: 1 } } } },
    });
    expect(r.statusCode).toBe(403);
  });
});
