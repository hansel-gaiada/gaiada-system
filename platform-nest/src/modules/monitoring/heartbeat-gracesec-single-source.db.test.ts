// GRACESEC — pins "the stored grace period and the enforced grace period cannot differ" for
// heartbeat monitors, against a REAL database.
//
// ── THE DEFECT THIS FILE EXISTS TO CATCH ──────────────────────────────────────────────────────────
// `monitor_heartbeats.grace_sec` (0116) used to be written ONCE at monitor creation and never
// updated — `updateMonitor`'s PATCH path only ever touched `monitors.config`. The runner's
// DUE_SELECT aliased the column in as `hb_grace_sec` but never passed it to the driver: the grace
// period `evaluateHeartbeat` actually used always came from `driver.validate(row.config)`, i.e.
// `monitors.config.graceSec`. So a monitor patched to a new grace period kept being enforced against
// its ORIGINAL, frozen value forever — this cost a real debugging cycle (see
// runner-notify-delivery.db.test.ts's fixture comment). Migration 202609031200 removed the column
// outright, on the reasoning that `monitors.config.graceSec` was already the only value either write
// path (create AND patch) kept current, and a repo-wide grep found no other reader of the column.
//
// ── WHAT WOULD HAVE CAUGHT IT, AND DOES NOW ──────────────────────────────────────────────────────
// The behavioural test below creates a heartbeat monitor with a SHORT grace (60s), drives it overdue
// by a stale `last_seen_at`, confirms the sweep marks it `down`, then PATCHES the grace period to a
// LONG value (1000s) covering the SAME staleness and re-sweeps. If the runner were still reading a
// frozen `monitor_heartbeats.grace_sec` written at creation (60s), the second sweep would still see
// 320s of silence > 60s grace and report `down` forever, never recovering. Only reading the current
// `monitors.config.graceSec` (the value PATCH just changed) makes the monitor recover to `up`. This
// is exactly the shape of bug described above, reproduced and pinned rather than merely described.
//
// The schema test above it is the structural half: `monitor_heartbeats` must never regain a grace
// column, or the two-representations trap could be reintroduced by a careless future migration.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { resetModules, registerModule } from "../registry";
import { buildApp } from "../../main";
import { monitoringModule } from "./index";
import { resetDrivers, registerDriver } from "./drivers/registry";
import { heartbeatDriver } from "./drivers/heartbeat";
import { runSweep } from "./runner";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";

describe.skipIf(!TEST_URL)("GRACESEC · monitor_heartbeats has no grace column to drift", () => {
  beforeAll(async () => {
    await initTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("the column is gone, not merely unused — a stale representation cannot be reintroduced by accident", async () => {
    const { rows } = await adminPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'monitor_heartbeats' AND column_name = 'grace_sec'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!TEST_URL)("GRACESEC · a heartbeat monitor's enforced grace tracks config, always", () => {
  let app: NestFastifyApplication;
  let tenantId: string;
  let clientId: string;
  let staff: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetDrivers();
    registerModule(monitoringModule);
    registerDriver(heartbeatDriver);

    tenantId = await createCompany("Gracesec Co", ["monitoring"]);
    clientId = await createClient(tenantId, "Gracesec Client");
    staff = await createUser("gracesec-staff@a.test");
    await addMembership(tenantId, staff);
    // `monitoring_staff` is a global role name Cerbos matches literally (0117) — an arbitrary role
    // name here would carry no permissions at all and every request below would 403 regardless of
    // what this test is trying to prove.
    const staffRole = await createRole("monitoring_staff");
    await grantRole(staff, staffRole, "company", tenantId);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("PATCHing graceSec changes what the NEXT sweep enforces, not just what got stored at creation", async () => {
    // T0 anchors on REAL current time, not an arbitrary fixed date: `monitor_results` is
    // RANGE-partitioned and `ensureResultPartitions` (runner.ts) derives its bounds from the
    // database's own `now()`, ignoring whatever `now` argument `runSweep` is called with (see its
    // own comment). An arbitrary historical anchor like 2026-01-01 has no partition to land in and
    // makes the sweep's `INSERT INTO monitor_results` throw "no partition of relation found for
    // row" — found by running this very test. Offsets from real `now()` keep the scenario
    // deterministic in every way that matters (the staleness deltas, not the wall-clock instant)
    // while staying inside whatever partition actually exists.
    const T0 = new Date();

    const created = await app.inject({
      method: "POST",
      url: `/api/${tenantId}/monitoring/monitors`,
      headers: asUser(staff),
      payload: { name: "gracesec-probe", kind: "heartbeat", clientId, intervalSec: 60, graceSec: 60 },
    });
    expect(created.statusCode).toBeLessThan(300);
    const monitorId = created.json().id as string;

    // Overdue by 200s against the 60s grace it was created with — but the timestamp is set directly
    // rather than by waiting, so the scenario stays instant and hermetic.
    await adminPool().query(
      `UPDATE monitor_heartbeats SET last_seen_at = $2 WHERE monitor_id = $1`,
      [monitorId, new Date(T0.getTime() - 200_000)],
    );

    const firstSweep = await runSweep(T0);
    expect(firstSweep.probed).toBeGreaterThan(0);

    const afterFirst = await adminPool().query<{ status: string }>(
      `SELECT status FROM monitors WHERE id = $1`,
      [monitorId],
    );
    // 200s of silence against a 60s grace: DOWN. This is the pre-condition the recovery below must
    // actually flip, or the second assertion would prove nothing.
    expect(afterFirst.rows[0].status).toBe("down");
    const openIncident = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL`,
      [monitorId],
    );
    expect(Number(openIncident.rows[0].n)).toBe(1);

    // Widen the grace to 1000s — comfortably covering the SAME 200s+ of staleness the monitor is
    // already sitting on. `last_seen_at` is left untouched: only the configured grace changes.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/${tenantId}/monitoring/monitors/${monitorId}`,
      headers: asUser(staff),
      payload: { graceSec: 1000 },
    });
    expect(patched.statusCode).toBe(200);

    // T1 is past the 60s interval so isDue() re-evaluates it, and the accumulated silence (320s) is
    // still comfortably under the NEW 1000s grace but would still be OVER the OLD 60s grace — the
    // discriminating gap between "reads config" and "reads a frozen column" this test exists for.
    const T1 = new Date(T0.getTime() + 120_000);
    const secondSweep = await runSweep(T1);
    expect(secondSweep.probed).toBeGreaterThan(0);

    const afterSecond = await adminPool().query<{ status: string }>(
      `SELECT status FROM monitors WHERE id = $1`,
      [monitorId],
    );
    // If the runner had read a frozen `monitor_heartbeats.grace_sec` (60, written at creation) this
    // would still be 'down' — 320s of silence exceeds 60s. It is only 'up' because the ONLY grace
    // period that has ever existed after this ticket is `monitors.config.graceSec`, and PATCH just
    // changed it.
    expect(afterSecond.rows[0].status).toBe("up");
    const closedIncident = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL`,
      [monitorId],
    );
    expect(Number(closedIncident.rows[0].n)).toBe(0);
  });
});
