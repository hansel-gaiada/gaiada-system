// MON-12 — runSweep() against REAL RLS. This file exists because the pure suite could not have
// caught the defect it pins.
//
// THE BUG: runSweep() wrapped everything in `withGlobal`, documented as "a platform-wide background
// job that must see every tenant's monitors". `monitors` composes its policy as
// `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('monitoring')`; `withGlobal` sets
// neither GUC and the app role is NOBYPASSRLS. The due-select therefore matched ZERO ROWS, returned
// success, and the runner reported healthy sweeps while probing nothing.
//
// WHY NOTHING ELSE FOUND IT. runner.test.ts is pure — it tests `isDue`/`decideTransition` with no
// database, so the query that returned nothing was never executed. And in production the only
// module-enabled tenant has no monitors yet, so "swept 0" is exactly what a CORRECT run looks like
// too. An empty result is indistinguishable from a right answer; only a fixture with a monitor that
// MUST be seen can tell them apart.
//
// So every assertion below is a positive one: the sweep must SEE something. A negative assertion
// ("no errors", "returns a result") would have passed against the broken version.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently without it — and a skipped run of this file proves
// nothing while looking identical to a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSweep } from "./runner";
import { resetDrivers, registerDriver } from "./drivers/registry";
import { heartbeatDriver } from "./drivers/heartbeat";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";

describe.skipIf(!TEST_URL)("MON-12 · runSweep sees monitors through RLS", () => {
  let enabled: string;
  let disabled: string;
  let monitorId: string;

  beforeAll(async () => {
    await initTestDb();
    resetDrivers();
    // heartbeat is the only driver that probes NOTHING over the network — the inverse check reads
    // stored liveness. That keeps this suite hermetic: no egress, no timeouts, no flakes.
    registerDriver(heartbeatDriver);

    enabled = await createCompany("Swept Co", ["monitoring"]);
    disabled = await createCompany("Unswept Co"); // module OFF — the contrast control
    const clientA = await createClient(enabled, "Client A");
    const clientB = await createClient(disabled, "Client B");

    const pool = adminPool();
    // Due by construction: last_checked_at NULL means never checked, which isDue() treats as due now.
    const m = await pool.query<{ id: string }>(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, status, severity, interval_sec, last_checked_at)
       VALUES ($1,$2,'nightly-sweep','heartbeat','unknown','ticket',60,NULL) RETURNING id`,
      [enabled, clientA],
    );
    monitorId = m.rows[0].id;
    await pool.query(
      `INSERT INTO monitor_heartbeats (tenant_id, client_id, monitor_id, token_hash, grace_sec)
       VALUES ($1,$2,$3,'deadbeef',300)`,
      [enabled, clientA, monitorId],
    );

    // A monitor in the module-DISABLED company. The third wall must keep it out of the sweep.
    await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, status, severity, interval_sec, last_checked_at)
       VALUES ($1,$2,'must-not-be-swept','heartbeat','unknown','ticket',60,NULL)`,
      [disabled, clientB],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("CONSIDERS a due monitor — the assertion the broken version failed", async () => {
    // Against `withGlobal`, `considered` was 0 here. That single number is the whole defect.
    const res = await runSweep(new Date());
    expect(res.considered).toBeGreaterThan(0);
  });

  it("actually WRITES a result row for it, so the board stops saying 'never'", async () => {
    await runSweep(new Date());
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_results WHERE tenant_id = $1 AND monitor_id = $2`,
      [enabled, monitorId],
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);

    // And the monitor's own row must move off "never checked".
    const m = await adminPool().query<{ last_checked_at: Date | null }>(
      `SELECT last_checked_at FROM monitors WHERE id = $1`,
      [monitorId],
    );
    expect(m.rows[0].last_checked_at).not.toBeNull();
  });

  it("does NOT sweep a company whose module is off — the third wall still applies per tenant", async () => {
    // Proves the per-tenant loop did not become a way around `app_module_allowed`: the fix must open
    // exactly the intended door and no other.
    await runSweep(new Date());
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_results WHERE tenant_id = $1`,
      [disabled],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("rolls result partitions forward even with no work to do", async () => {
    // Partition DDL is global and must not have been dragged inside the per-tenant transaction.
    await runSweep(new Date());
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_tables WHERE tablename LIKE 'monitor_results_2%'`,
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(4);
  });
});
