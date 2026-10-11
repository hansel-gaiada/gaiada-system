// PV1-01 — each company carries a vertical (migration 202610110530_company_verticals.sql), and
// `/api/me` returns what the staff menu needs per company: vertical, the effective module set, and the
// root (PV-D14, PV-D11, PV-D20).
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count). Runs on the
// Linux server gate, not locally. The test database is migrated while EMPTY, so the backfill meets no
// rows here; company-verticals.test.ts pins the backfill's mapping instead, and the migration's own DO
// block asserts it against real rows on deploy.
//
// Teeth: drop `vertical` from the /me SELECT and the /api/me case fails; drop the REFERENCES clause and
// the unknown-vertical case fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import { withGlobal } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PV1-01 · company verticals and /api/me", () => {
  let app: NestFastifyApplication;
  let root: string;
  let child: string;
  let staff: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    root = await createCompany("Vertical Holding");
    child = await createCompany("Vertical Agency", ["agency", "clients"], root);
    await withGlobal((c) => c.query(`UPDATE companies SET type = 'holding', vertical = 'holding' WHERE id = $1`, [root]));
    await withGlobal((c) => c.query(`UPDATE companies SET type = 'agency', vertical = 'agency' WHERE id = $1`, [child]));
    staff = await createUser("staff@pv101.test");
    for (const co of [root, child]) await addMembership(co, staff);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("the lookup lists exactly the five verticals", async () => {
    const r = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM company_verticals ORDER BY id`));
    expect(r.rows.map((x) => x.id)).toEqual(["agency", "catering", "general", "holding", "hospitality"]);
  });

  it("a new company defaults to general, and the foreign key refuses an unknown vertical", async () => {
    const co = await createCompany("Vertical Default Co");
    const r = await withGlobal((c) => c.query<{ vertical: string }>(`SELECT vertical FROM companies WHERE id = $1`, [co]));
    expect(r.rows[0].vertical).toBe("general");
    await expect(
      withGlobal((c) => c.query(`UPDATE companies SET vertical = 'casino' WHERE id = $1`, [co])),
    ).rejects.toThrow(/company_verticals|foreign key/i);
  });

  it("GET /api/me returns vertical, enabledModules and rootCompanyId for each company", async () => {
    const r = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staff) });
    expect(r.statusCode).toBe(200);
    const companies = r.json().companies as { id: string; vertical: string; enabledModules: string[]; rootCompanyId: string }[];
    const rootRow = companies.find((x) => x.id === root)!;
    const childRow = companies.find((x) => x.id === child)!;
    expect(rootRow).toMatchObject({ vertical: "holding", rootCompanyId: root });
    expect(childRow).toMatchObject({ vertical: "agency", rootCompanyId: root });
    expect(childRow.enabledModules).toEqual(expect.arrayContaining(["agency", "clients"]));
    expect(Array.isArray(rootRow.enabledModules)).toBe(true);
  });
});
