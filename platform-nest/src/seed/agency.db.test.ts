// TR-43 ratification (senior-be, §15 2026-08-01) — regression coverage for `seedCheckinsAndFacts`
// inside seed/agency.ts, the ONLY seed file that previously had zero test coverage. TR-30 reported
// "seed extended, idempotency preserved" having only run `tsc` on one file and NEVER EXECUTED the
// seed; TR-29 then found (and a devops agent fixed, live-verified but until now uncommitted and
// untested) three real bugs in the check-in/work-activity block:
//   1. the real column is `checkin_date`, not the `check_in_date` TR-30 wrote,
//   2. `source` must be a CHECK-valid value ('ui','wa','mcp','system' — see
//      0056_module_reports_core.sql's `report_checkins` DDL) — TR-30 wrote 'user', which the
//      CHECK constraint rejects outright,
//   3. `report_checkins`/`work_activity`-adjacent inserts run inside `withTenants([tenantId])`
//      that must declare `{modules:['reports']}` (WSD-4's third RLS wall,
//      `app_module_allowed('reports')`) or the insert is rejected for every row, silently from the
//      caller's point of view unless it's actually run.
//
// This file proves the fix by EXECUTING seedAgency() against a real Postgres (never by reading the
// INSERT statements), the same standard TR-29 held itself to:
//   - the check-ins really land, with the real column name and a CHECK-valid source;
//   - work_activity rows land for the fact job to consume;
//   - a full second `seedAgency()` run does not duplicate either table (idempotency by row count,
//     not by inspecting ON CONFLICT clauses);
//   - the seeded data survives the real fact-job recompute and comes back out through the real
//     `GET /reports/document` HTTP endpoint as a non-empty, reviewable report — the actual point of
//     seeding check-ins/activity at all.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { recomputeFactWindow } from "../modules/reports/fact-job";
import { seedAgency, type SeededAgency } from "./agency";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("seed/agency.ts — check-in + work-activity seeding (TR-43 ratification)", () => {
  let app: NestFastifyApplication;
  let seeded: SeededAgency;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    seeded = await seedAgency();
    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("seeds report_checkins with the real column name and a CHECK-valid source (bug 1 + 2)", async () => {
    const { rows } = await adminPool().query<{ user_id: string; checkin_date: string; source: string; status: string }>(
      `SELECT user_id, checkin_date::text, source, status FROM report_checkins WHERE tenant_id=$1 ORDER BY checkin_date, user_id`,
      [seeded.tenantId],
    );
    // A wrong column name would have made this whole query fail against the real schema; a CHECK
    // violation on `source` (or on `status`) would have made those INSERTs throw before landing here.
    // Every row is asserted against the CHECK-valid domains rather than against a total row count:
    // seed/departments.ts also seeds check-ins, for the WHOLE placed roster, so a fixed count here
    // would pin this test to the roster size and break every time someone is added to it.
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      expect(["ui", "wa", "mcp", "system"]).toContain(r.source);
      expect(["submitted", "auto_missed", "excused"]).toContain(r.status);
    }
    // seedCheckinsAndFacts's own contribution is still exactly what it was: pm/designer/copy,
    // 4 consecutive days (today-3..today), all 'submitted'.
    const core = rows.filter((r) => [seeded.users.pm, seeded.users.designer, seeded.users.copy].includes(r.user_id));
    const coreDates = new Set(core.filter((r) => r.status === "submitted").map((r) => r.checkin_date));
    expect(coreDates.size).toBeGreaterThanOrEqual(4);
  });

  it("seeds work_activity rows for the fact job to consume (RLS scope fix, bug 3)", async () => {
    // Fetched with the ADMIN (superuser, RLS-bypassing) pool purely to inspect what's really
    // stored — the meaningful proof that bug 3 is fixed is the NEXT test, which reads this same
    // data back through the app's own `withTenants([tenantId], ..., {modules:['reports']})` path
    // (via the fact job + HTTP endpoint) and gets a non-empty result. If the module scope were
    // still missing, `seedAgency()` itself would have thrown when this file's `beforeAll` ran,
    // because `withTenants(..., {modules:['reports']})`'s WITH CHECK rejects the INSERT outright.
    const { rows } = await adminPool().query(
      `SELECT source, verb, object_kind FROM work_activity WHERE tenant_id=$1 AND source='pm' AND verb='completed'`,
      [seeded.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second full seedAgency() run does not duplicate check-ins or activity (by row count, not by reading ON CONFLICT)", async () => {
    const countCheckins = async (): Promise<number> =>
      Number((await adminPool().query(`SELECT count(*)::int n FROM report_checkins WHERE tenant_id=$1`, [seeded.tenantId])).rows[0].n);
    const countActivity = async (): Promise<number> =>
      Number((await adminPool().query(`SELECT count(*)::int n FROM work_activity WHERE tenant_id=$1`, [seeded.tenantId])).rows[0].n);

    const checkinsBefore = await countCheckins();
    const activityBefore = await countActivity();
    expect(checkinsBefore).toBeGreaterThan(0);
    expect(activityBefore).toBeGreaterThan(0);

    // Re-run the WHOLE seed — the same function `npm run seed:agency` invokes — not just the
    // check-in helper, so this also exercises every other idempotent ensure-* step alongside it.
    await seedAgency();

    expect(await countCheckins()).toBe(checkinsBefore);
    expect(await countActivity()).toBe(activityBefore);
  });

  it("the seeded data survives recompute and comes back non-empty through the real GET /reports/document endpoint", async () => {
    const today = new Date();
    const from = new Date(today.getTime() - 4 * 86_400_000).toISOString().slice(0, 10);
    const to = today.toISOString().slice(0, 10);

    const result = await recomputeFactWindow(seeded.tenantId, from, to);
    expect(result.factRows).toBeGreaterThan(0);

    const r = await app.inject({
      method: "GET",
      url: `/api/${seeded.tenantId}/reports/document?grain=company&scopeRef=${seeded.tenantId}&periodKind=custom&start=${from}&end=${to}`,
      headers: asUser(seeded.users.admin),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Array.isArray(body.kpis)).toBe(true);
    expect(body.kpis.length).toBeGreaterThan(0);
    // The whole point of seeding check-ins/work-activity: the report is reviewable, not a wall of
    // zeroes. The seed's own PM time entries (seedPm) plus the task-completion activity seeded
    // here give at least one KPI a genuine non-zero value.
    const hasSignal = body.kpis.some((k: { value?: number }) => typeof k.value === "number" && k.value !== 0);
    expect(hasSignal).toBe(true);
  });
});
