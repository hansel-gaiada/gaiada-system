// A hung probe must NOT wedge the sweep — the hard per-probe deadline bounds it.
//
// ── THE PRODUCTION INCIDENT THIS LOCKS ─────────────────────────────────────────────────────────
// The http driver's timeout is socket-INACTIVITY only; a trickling response, or a stall before a
// socket exists, never trips it. Because the whole per-tenant sweep runs in ONE transaction, a
// single hung probe left the DB connection `idle in transaction` indefinitely and — via the chained
// setTimeout loop — stopped every future tick, so ALL monitoring froze. This asserts the deadline
// converts a hang into a bounded DOWN observation and lets the sweep finish.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSweep } from "./runner";
import { resetDrivers, registerDriver } from "./drivers/registry";
import type { MonitorDriver, ProbeResult } from "./drivers/registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";

// A driver that hangs forever — the worst case the deadline exists for.
const hangingTcpDriver: MonitorDriver<Record<string, unknown>> = {
  kind: "tcp",
  capabilities: [],
  validate: () => ({}),
  probe: (): Promise<ProbeResult> => new Promise<ProbeResult>(() => { /* never resolves */ }),
};

describe.skipIf(!TEST_URL)("MON · a hung probe cannot wedge the sweep", () => {
  const DOMAIN = "hang-probe.test";

  beforeAll(async () => {
    await initTestDb();
    resetDrivers();
    registerDriver(hangingTcpDriver);

    const tenant = await createCompany("Deadline Co", ["monitoring", "search"]);
    const client = await createClient(tenant, "Deadline Client");
    const pool = adminPool();
    await pool.query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, verified_at, origin_site)
       VALUES ($1, $2, $3, $4, now(), 'deadline-test')`,
      [tenant, client, DOMAIN, `https://${DOMAIN}`],
    );
    await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, config, target, status, severity, interval_sec, last_checked_at)
       VALUES ($1, $2, 'hang-check', 'tcp', '{}'::jsonb, $3, 'unknown', 'ticket', 60, NULL)`,
      [tenant, client, `${DOMAIN}:443`],
    );
  }, 120_000);

  afterAll(async () => {
    resetDrivers();
    await teardownTestDb();
  });

  it("finishes instead of hanging, and records the hung monitor as down", async () => {
    // timeoutMs=0 -> a 5s hard deadline. Without the deadline this call never resolves and the whole
    // suite times out — which is exactly the production symptom, in miniature.
    const res = await runSweep(new Date(), 0);
    expect(res.probed).toBeGreaterThan(0);

    const { rows } = await adminPool().query<{ status: string; detail: string | null }>(
      `SELECT status, detail FROM monitor_results ORDER BY checked_at DESC LIMIT 1`,
    );
    expect(rows[0].status).toBe("down");
    expect(rows[0].detail ?? "").toMatch(/hard deadline/);
  }, 30_000);
});
