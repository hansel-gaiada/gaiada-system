// The SSRF allowlist reaches a dialing driver ONLY because the sweep declares the `search` scope.
//
// ── THE BUG THIS LOCKS ─────────────────────────────────────────────────────────────────────────
// A monitor's allowlist is built inside the sweep from `search_properties` (verified rows), a table
// the SEARCH module owns: its RLS is `tenant_id = ANY(app_current_tenants()) AND
// app_module_allowed('search')`. The sweep used to declare `{ modules: ["monitoring"] }` only, so
// `app.scopes` had no `search`, the allowlist subquery returned ZERO rows for EVERY monitor, and
// every http/tcp/tls probe was refused with "host is not allowlisted" — the whole estate reported
// DOWN while nothing was wrong. The fix adds `search` to the sweep's scope.
//
// ── WHY THE EXISTING RUNSWEEP SUITE COULD NOT CATCH IT ─────────────────────────────────────────
// `runner-sweep.db.test.ts` uses the HEARTBEAT driver on purpose — it dials nothing and never
// consults the allowlist, which keeps that suite hermetic. So the allowlist-from-search_properties
// path was never exercised under RLS. This test fills exactly that gap: a DIALING kind whose driver
// captures the allowlist it is handed, asserted against a verified property. It needs no network —
// the fake driver records `ctx.allowlistHosts` and returns without dialing — so it stays hermetic
// while still proving the scope wiring end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSweep } from "./runner";
import { resetDrivers, registerDriver } from "./drivers/registry";
import type { MonitorDriver, ProbeCtx, ProbeResult } from "./drivers/registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";

// A dialing kind (tcp) whose driver dials NOTHING — it captures the allowlist the sweep handed it.
// If the sweep declared only `monitoring`, RLS hides search_properties and this list comes back [].
let captured: string[] | null = null;
const capturingTcpDriver: MonitorDriver<Record<string, unknown>> = {
  kind: "tcp",
  capabilities: [],
  validate: () => ({}),
  probe: async (_config: Record<string, unknown>, ctx: ProbeCtx): Promise<ProbeResult> => {
    captured = ctx.allowlistHosts;
    return { status: "up", latencyMs: 1, detail: null };
  },
};

describe.skipIf(!TEST_URL)("MON · the sweep's allowlist reads search_properties under RLS", () => {
  const DOMAIN = "allowlist-probe.test";

  beforeAll(async () => {
    await initTestDb();
    resetDrivers();
    registerDriver(capturingTcpDriver);

    const tenant = await createCompany("Allowlist Co", ["monitoring", "search"]);
    const client = await createClient(tenant, "Allowlist Client");
    const pool = adminPool();

    // A VERIFIED property for this client — the only thing that may legitimately populate the
    // allowlist. verified_at set = it has passed the consent checkpoint.
    await pool.query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, verified_at, origin_site)
       VALUES ($1, $2, $3, $4, now(), 'allowlist-test')`,
      [tenant, client, DOMAIN, `https://${DOMAIN}`],
    );
    // A due tcp monitor for that client, targeting the verified domain.
    await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, config, target, status, severity, interval_sec, last_checked_at)
       VALUES ($1, $2, 'allowlist-check', 'tcp', '{}'::jsonb, $3, 'unknown', 'ticket', 60, NULL)`,
      [tenant, client, `${DOMAIN}:443`],
    );
  }, 120_000);

  afterAll(async () => {
    resetDrivers();
    await teardownTestDb();
  });

  it("hands the driver the verified domain — proving the search scope is applied", async () => {
    captured = null;
    await runSweep(new Date());
    // The exact assertion the missing scope violated: the allowlist is non-empty and contains the
    // verified property's domain. Under the old `["monitoring"]`-only scope this was [].
    expect(captured).not.toBeNull();
    expect(captured).toContain(DOMAIN);
  });
});
