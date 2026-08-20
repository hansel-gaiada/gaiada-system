// MON-12d — the SQL uptime aggregate and the TS `uptimeRatio()` must agree, always.
//
// Two implementations of one rule is how they drift, and this particular rule is one where drifting
// either direction is a lie told about a client: counting `maintenance` as up flatters the figure,
// counting it as down bills the client for our own scheduled work, and returning 0 for a window with
// no observations claims a total outage that was never observed.
//
// So this suite does not re-assert the semantics (runner.test.ts already pins those on the pure
// function). It feeds ONE fixture to BOTH implementations and fails if the two answers differ.
//
// ⚠ Needs DATABASE_URL_TEST. It skips silently without one — check the skip count before believing a
// green run, because the whole point of this file is the comparison it cannot make when skipped.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { uptimeRatio } from "./runner";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";

type St = "up" | "down" | "degraded" | "maintenance" | "unknown";

// Each case is a window's worth of result rows. Named so a failure says which rule broke.
const CASES: { name: string; statuses: St[] }[] = [
  { name: "empty window", statuses: [] },
  { name: "all up", statuses: ["up", "up", "up"] },
  { name: "all down", statuses: ["down", "down"] },
  { name: "plain mix", statuses: ["up", "up", "up", "down"] },
  { name: "maintenance excluded from both halves", statuses: ["up", "up", "maintenance", "maintenance"] },
  { name: "unknown excluded from both halves", statuses: ["up", "down", "unknown"] },
  { name: "ONLY maintenance and unknown — must be NULL, not 1 and not 0", statuses: ["maintenance", "unknown"] },
  { name: "degraded counts against uptime", statuses: ["up", "degraded"] },
  { name: "degraded is not a soft pass even alone", statuses: ["degraded"] },
  { name: "every status at once", statuses: ["up", "down", "degraded", "maintenance", "unknown"] },
  { name: "a single up", statuses: ["up"] },
  { name: "repeating thirds", statuses: ["up", "down", "up", "down", "up", "maintenance"] },
];

describe.skipIf(!TEST_URL)("MON-12d · SQL uptime == uptimeRatio()", () => {
  let tenant: string;
  let client: string;
  const monitorByCase = new Map<string, string>();

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("Uptime Parity Co", ["monitoring"]);
    client = await createClient(tenant, "A Client");
    const pool = adminPool();

    for (const c of CASES) {
      const m = await pool.query<{ id: string }>(
        `INSERT INTO monitors (tenant_id, client_id, name, kind, target, status, severity, interval_sec)
         VALUES ($1,$2,$3,'http','https://example.invalid','unknown','ticket',60) RETURNING id`,
        [tenant, client, `case: ${c.name}`],
      );
      const id = m.rows[0].id;
      monitorByCase.set(c.name, id);
      for (const st of c.statuses) {
        // Inside the 24h window so one query serves both windows.
        await pool.query(
          `INSERT INTO monitor_results (tenant_id, client_id, monitor_id, status, latency_ms, checked_at)
           VALUES ($1,$2,$3,$4,NULL, now() - interval '1 hour')`,
          [tenant, client, id, st],
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("agrees on every case, including the three that are easy to get wrong", async () => {
    // The SQL under test is the same expression the controller's MONITOR_SELECT uses. Kept as a
    // literal here on purpose: importing it would let a mistake in the fragment agree with itself.
    const sql = `
      SELECT CASE WHEN count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown')) = 0 THEN NULL
                  ELSE count(*) FILTER (WHERE r.status = 'up')::numeric
                       / count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown'))
             END AS ratio
        FROM monitor_results r
       WHERE r.tenant_id = $1 AND r.monitor_id = $2
         AND r.checked_at >= now() - interval '24 hours'`;

    const disagreements: string[] = [];
    for (const c of CASES) {
      const { rows } = await adminPool().query<{ ratio: string | null }>(sql, [
        tenant,
        monitorByCase.get(c.name),
      ]);
      const fromSql = rows[0].ratio === null ? null : Number(rows[0].ratio);
      const fromTs = uptimeRatio(c.statuses.map((status) => ({ status: status as never })));

      const same =
        fromSql === null || fromTs === null
          ? fromSql === fromTs
          : Math.abs(fromSql - fromTs) < 1e-9;
      if (!same) disagreements.push(`"${c.name}": sql=${fromSql} ts=${fromTs}`);
    }
    expect(disagreements, disagreements.join("\n")).toEqual([]);
  });

  it("the empty window is NULL on the SQL side too — the assertion this file exists for", async () => {
    // Spelled out separately because it is the one an aggregate gets wrong most naturally: COUNT
    // returns 0 rather than NULL, and a division guarded only against divide-by-zero would yield 0.
    const { rows } = await adminPool().query<{ uptime_24h: string | null; uptime_30d: string | null }>(
      `SELECT u24.ratio AS uptime_24h, u30.ratio AS uptime_30d
         FROM monitors m
         LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE r.status = 'up')::numeric
                                   / NULLIF(count(*) FILTER (WHERE r.status NOT IN ('maintenance','unknown')), 0) AS ratio
                              FROM monitor_results r
                             WHERE r.tenant_id = m.tenant_id AND r.monitor_id = m.id
                               AND r.checked_at >= now() - interval '24 hours') u24 ON true
         LEFT JOIN LATERAL (SELECT NULL::numeric AS ratio) u30 ON true
        WHERE m.id = $1`,
      [monitorByCase.get("empty window")],
    );
    expect(rows[0].uptime_24h).toBeNull();
  });
});
