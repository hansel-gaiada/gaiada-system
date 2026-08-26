// WSK-05 — a direct unit-level regression test on TenantAwarePool itself (the mechanism this
// ticket's whole tenancy story rests on — see db/tenant-pool.ts's header), independent of the
// HTTP layer. Mirrors WSK-00's own P13 negative control (webdesk/spike-rls/payload/src/
// tenant-pg.mjs's `tenantCheckoutLog`): force a physical connection to be reused across two
// different tenant contexts via a pool with max=1, and prove directly — via
// `current_setting('webdesk.tenant_ctx', true)` read on the connection itself, not just via a
// higher-level query result — that the GUC is always exactly what the current caller asked for,
// never a leftover from the previous borrower.
import { afterAll, describe, expect, it } from "vitest";
import { createTenantAwarePool } from "../src/db/tenant-pool";
import { runWithTenant } from "../src/db/tenant-context";

const APP_DATABASE_URL =
  process.env.WSK05_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

describe("WSK-05 TenantAwarePool — forced-reuse leak probe", () => {
  const pool = createTenantAwarePool({ connectionString: APP_DATABASE_URL, max: 1 });

  afterAll(async () => {
    await pool.end();
  });

  it("pigeonholes THREE sequential checkouts through a max=1 pool onto the SAME physical connection", async () => {
    const tenantIds = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", ""];
    const observed: (string | null)[] = [];

    for (const tenantId of tenantIds) {
      const run = tenantId
        ? (fn: () => Promise<void>) => runWithTenant(tenantId, fn)
        : (fn: () => Promise<void>) => fn(); // no ALS context at all — the "unauthenticated" case

      await run(async () => {
        const client = await pool.connect();
        try {
          const { rows } = await client.query("select current_setting('webdesk.tenant_ctx', true) as v");
          observed.push(rows[0].v === "" ? null : rows[0].v);
        } finally {
          client.release();
        }
      });
    }

    expect(observed).toEqual(["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", null]);

    // Pigeonhole: with max=1, three sequential checkouts on an otherwise-idle pool CANNOT be
    // three different physical connections — the checkout log's connId proves it directly rather
    // than inferring it from timing.
    const connIds = new Set(pool.checkoutLog.filter((e) => e.phase === "checkout").map((e) => e.connId));
    expect(connIds.size).toBe(1);
  });

  it("negative control: a raw pg.Pool (no wrapper) DOES leak — proves the probe above can fail", async () => {
    const { Pool } = await import("pg");
    const rawPool = new Pool({ connectionString: APP_DATABASE_URL, max: 1 });
    try {
      const client1 = await rawPool.connect();
      await client1.query("select set_config('webdesk.tenant_ctx', $1, false)", ["33333333-3333-3333-3333-333333333333"]);
      client1.release(); // no scrub — this is the bug TenantAwarePool exists to make impossible

      const client2 = await rawPool.connect(); // same physical connection, max=1
      const { rows } = await client2.query("select current_setting('webdesk.tenant_ctx', true) as v");
      client2.release();

      expect(rows[0].v).toBe("33333333-3333-3333-3333-333333333333"); // the leak, reproduced on demand
    } finally {
      await rawPool.end();
    }
  });
});
