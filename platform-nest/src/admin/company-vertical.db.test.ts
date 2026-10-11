// PV1-03 (PV-D16, PV-D17) — company writes respect the vertical.
//   * POST /api/companies: a new company carries its `vertical`, and a body with NO `modules` starts
//     from that vertical's pack defaults. A body WITH `modules` keeps exactly those.
//   * PATCH /api/companies/:id: only platform_admin (global) may change `vertical`; a company_admin gets
//     403 and the row is untouched. Changing the vertical never resets `enabled_modules`.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { packFor } from "../core/packs";

const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

describe.skipIf(!TEST_URL)("company writes respect the vertical (PV1-03)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let companyAdmin: string;
  let platformAdmin: string;

  const row = async (id: string) =>
    (await adminPool().query(`SELECT vertical, enabled_modules FROM companies WHERE id = $1`, [id])).rows[0] as {
      vertical: string; enabled_modules: string[];
    };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("PV1-03 Co");
    companyAdmin = await createUser("pv103-company-admin@a.test");
    platformAdmin = await createUser("pv103-platform-admin@a.test");
    await addMembership(co, companyAdmin);
    await grantRole(companyAdmin, await createRole("company_admin"), "company", co);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/companies", headers: asUser(platformAdmin), payload });

  it("create with a vertical and no modules starts from the pack defaults", async () => {
    const r = await create({ name: "PV1-03 Agency Co", vertical: "agency" });
    expect(r.statusCode).toBe(201);
    const got = await row(r.json().id);
    expect(got.vertical).toBe("agency");
    expect(got.enabled_modules).toEqual([...packFor("agency").defaultModules]);
  });

  it("create with no vertical is general and gets the generic pack", async () => {
    const r = await create({ name: "PV1-03 Plain Co" });
    expect(r.statusCode).toBe(201);
    const got = await row(r.json().id);
    expect(got.vertical).toBe("general");
    expect(got.enabled_modules).toEqual([...packFor("general").defaultModules]);
  });

  it("create with a vertical AND explicit modules keeps the modules as sent", async () => {
    const r = await create({ name: "PV1-03 Explicit Co", vertical: "agency", modules: ["pm"] });
    expect(r.statusCode).toBe(201);
    const got = await row(r.json().id);
    expect(got.vertical).toBe("agency");
    expect(got.enabled_modules).toEqual(["pm"]);
  });

  it("create with an unknown vertical is a 400 naming the field, and writes nothing", async () => {
    const r = await create({ name: "PV1-03 Casino Co", vertical: "casino" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "vertical" });
    const n = await adminPool().query(`SELECT 1 FROM companies WHERE name = 'PV1-03 Casino Co'`);
    expect(n.rowCount).toBe(0);
  });

  it("a company_admin PATCHing vertical gets 403 and the row is unchanged", async () => {
    const before = await row(co);
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(companyAdmin), payload: { vertical: "agency" },
    });
    expect(r.statusCode).toBe(403);
    expect(await row(co)).toEqual(before);
  });

  it("a company_admin sending an INVALID vertical still gets 403 (authz precedes validation)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(companyAdmin), payload: { vertical: "casino" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("a company_admin can still PATCH the other fields (name) without sending vertical", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(companyAdmin), payload: { name: "PV1-03 Co Renamed" },
    });
    expect(r.statusCode).toBe(200);
  });

  it("a platform_admin PATCH changes the vertical and leaves enabled_modules alone", async () => {
    await adminPool().query(`UPDATE companies SET enabled_modules = $2 WHERE id = $1`, [co, ["pm", "hr"]]);
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(platformAdmin), payload: { vertical: "agency" },
    });
    expect(r.statusCode).toBe(200);
    const got = await row(co);
    expect(got.vertical).toBe("agency");
    expect(got.enabled_modules).toEqual(["pm", "hr"]);
  });

  it("a platform_admin PATCH with an unknown vertical is a 400 and the row is unchanged", async () => {
    const before = await row(co);
    const r = await app.inject({
      method: "PATCH", url: `/api/companies/${co}`, headers: asUser(platformAdmin), payload: { vertical: "casino" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "vertical" });
    expect(await row(co)).toEqual(before);
  });
});
