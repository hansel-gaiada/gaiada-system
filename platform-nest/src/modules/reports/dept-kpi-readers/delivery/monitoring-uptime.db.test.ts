// DW-6n n2: `monitoring.client_uptime` (docs/FRONTEND-BFF-CONTRACT.md §40.5.3) against live Postgres + RLS. The reader is
// called directly with a ReaderCtx. Window: 2020-03-01 .. 2020-03-31 inclusive (a far-past month, so the partitions are
// created here and never collide with the roll-forward's).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../../../testing/setup";
import { uptimeRatio } from "../../../monitoring/runner";
import { clientSiteUptime } from "./monitoring-uptime";
import { at, seedDept, UNIT, type DeptWorld } from "../../../../testing/dept-kpi-seed";

type Status = "up" | "down" | "degraded" | "maintenance" | "unknown";

describe.skipIf(!TEST_URL)("DW-6n n2 clientSiteUptime (live PG + RLS)", () => {
  let w: DeptWorld;
  let other: DeptWorld;
  let off: DeptWorld;

  const ctx = (tenantId: string, over: Partial<{ start: string; end: string }> = {}) => ({
    tenantId,
    unitId: UNIT,
    periodKind: "custom" as const,
    start: over.start ?? "2020-03-01",
    end: over.end ?? "2020-03-31",
    asOf: over.end ?? "2020-03-31",
  });

  async function monitor(world: DeptWorld, client: string, name: string, opts: { enabled?: boolean; deleted?: boolean } = {}) {
    const { rows } = await adminPool().query<{ id: string }>(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, enabled, deleted_at)
       VALUES ($1,$2,$3,'http',$4,$5) RETURNING id`,
      [world.tenant, client, name, opts.enabled ?? true, opts.deleted ? new Date() : null],
    );
    return { id: rows[0].id, tenant: world.tenant, client };
  }
  async function result(m: { id: string; tenant: string; client: string }, status: Status, when: Date) {
    await adminPool().query(
      `INSERT INTO monitor_results (tenant_id, client_id, monitor_id, checked_at, status) VALUES ($1,$2,$3,$4,$5)`,
      [m.tenant, m.client, m.id, when, status],
    );
  }

  beforeAll(async () => {
    await initTestDb();
    for (const [name, from, to] of [
      ["202002", "2020-02-01", "2020-03-01"],
      ["202003", "2020-03-01", "2020-04-01"],
      ["202004", "2020-04-01", "2020-05-01"],
    ]) {
      await adminPool().query(
        `CREATE TABLE IF NOT EXISTS monitor_results_${name} PARTITION OF monitor_results FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
    }
    w = await seedDept("DW6n-n2 Co", ["monitoring"]);
    other = await seedDept("DW6n-n2 Other", ["monitoring"]);
    off = await seedDept("DW6n-n2 Off", []);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("is null when the department has no counted result, and maintenance/unknown alone do not count", async () => {
    expect(await clientSiteUptime(ctx(w.tenant))).toBeNull();
    const m = await monitor(w, w.clients.inUnit, "only-unmeasured");
    await result(m, "maintenance", await at("2020-03-10"));
    await result(m, "unknown", await at("2020-03-10", 60));
    expect(await clientSiteUptime(ctx(w.tenant))).toBeNull();
  });

  it("pools a client of the unit and a client of a child unit; excludes sibling, internal, disabled, deleted and other-tenant monitors", async () => {
    const day = await at("2020-03-15");
    const inUnit = await monitor(w, w.clients.inUnit, "in-unit-site");
    const child = await monitor(w, w.clients.child, "child-site");
    const sibling = await monitor(w, w.clients.sibling, "sibling-site");
    const internal = await monitor(w, w.clients.internal, "internal-site");
    const disabled = await monitor(w, w.clients.inUnit, "disabled-site", { enabled: false });
    const deleted = await monitor(w, w.clients.inUnit, "deleted-site", { deleted: true });
    const foreign = await monitor(other, other.clients.inUnit, "foreign-site");

    // Counted: in-unit up x3 + down x1, child up x1. Everything else is noise that must stay out.
    const counted: Status[] = ["up", "up", "up", "down"];
    for (const s of counted) await result(inUnit, s, day);
    await result(child, "up", day);
    for (const m of [sibling, internal, disabled, deleted]) for (const s of ["down", "down", "down"] as Status[]) await result(m, s, day);
    for (const s of ["down", "down"] as Status[]) await result(foreign, s, day);

    const v = await clientSiteUptime(ctx(w.tenant));
    expect(v).not.toBeNull();
    expect(v!.numerator).toBe(4);
    expect(v!.denominator).toBe(5);
    expect(v!.value).toBeCloseTo(0.8, 10);
  });

  it("equals uptimeRatio() over the same results; maintenance/unknown leave both sides, degraded counts against", async () => {
    const fresh = await seedDept("DW6n-n2 Parity", ["monitoring"]);
    const m = await monitor(fresh, fresh.clients.child, "parity-site");
    const statuses: Status[] = ["up", "up", "degraded", "down", "maintenance", "unknown", "up", "maintenance"];
    for (const [i, s] of statuses.entries()) await result(m, s, await at("2020-03-12", 60 * i));
    const expected = uptimeRatio(statuses.map((status) => ({ status })));
    const v = await clientSiteUptime(ctx(fresh.tenant));
    expect(expected).toBeCloseTo(3 / 5, 10);
    expect(v!.value).toBeCloseTo(expected!, 10);
    expect(v!.numerator).toBe(3);
    expect(v!.denominator).toBe(5);
  });

  it("window edges: the first instant counts, one second before does not; the last second counts, end + 1 day 00:00 does not", async () => {
    const fresh = await seedDept("DW6n-n2 Edges", ["monitoring"]);
    const m = await monitor(fresh, fresh.clients.inUnit, "edge-site");
    await result(m, "up", await at("2020-03-01")); // first instant: in
    await result(m, "down", await at("2020-03-01", -1)); // outside
    await result(m, "up", await at("2020-04-01", -1)); // last instant: in
    await result(m, "down", await at("2020-04-01")); // end + 1 day 00:00: out
    const v = await clientSiteUptime(ctx(fresh.tenant));
    expect(v!.numerator).toBe(2);
    expect(v!.denominator).toBe(2);
    expect(v!.value).toBe(1);
    // A one-day window on the last day reads only the last-second row.
    const one = await clientSiteUptime(ctx(fresh.tenant, { start: "2020-03-31", end: "2020-03-31" }));
    expect(one).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("a tenant without the monitoring module reads null, never an error (it has no module rows; the wall is the declared scope, not enabled_modules)", async () => {
    await expect(clientSiteUptime(ctx(off.tenant))).resolves.toBeNull();
  });
});
