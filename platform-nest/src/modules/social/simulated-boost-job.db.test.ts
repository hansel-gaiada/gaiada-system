// SCP-Se — the simulated boost job against live Postgres (needs DATABASE_URL_TEST: NOT run on the dev laptop, runs on the Linux CI
// gate; a skip is not a pass). No Nest app, no Cerbos: the job calls `completeBoost` (the route's own transition) directly. The pure half
// (the generator and the window setting) is publisher/simulated-boost.test.ts.
//
// Proves:
//   (B1) a RUNNING SIMULATED boost older than the window completes once, with exactly the generator's numbers, spend at or below the total,
//        `ended_at` and the results stamped, actor NULL, and ONE `complete_boost` activity row with `viaSimulator`.
//   (B2) a boost younger than the window waits, and completes on a later sweep once the window has passed (the clock is the sweep's `now`).
//   (B3) a REAL running boost, however old, is never touched: no row change, no activity; and the entry point itself refuses it (the
//        second fence), which the job would count as an error and never retry as real.
//   (B4) the switch OFF: nothing is read or written (`skipped`), and with it back on the same boost completes.
//   (B5) a rerun changes nothing (no second activity row, `updated_at` unchanged); a boost that is not `running` (approved, stopped,
//        cancelled) is not selected, and one that moved on between selection and the lock is skipped as `moved`, never an error.
//   (B6) an error in one boost is counted and logged and does not stop the next one.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { config } from "../../config";
import { newId } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { completeBoost } from "./pipeline/boosts";
import { simulatedBoostResult } from "./publisher/simulated-boost";
import { runSimulatedBoostSweep } from "./simulated-boost-job";

const MIN = 60_000;
const WINDOW = 10;

describe.skipIf(!TEST_URL)("SCP-Se · a started simulated boost completes by itself", () => {
  const before = { flag: config.socialSimulationEnabled, minutes: config.social.simulatedBoostMinutes };
  let A: string;
  let user: string;
  let engagementId: string;
  let cycleId: string;
  let clientId: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("SCP-Se Agency", ["social"]);
    user = await createUser("scp-se-officer@mock.test", "Mock Officer");
    await addMembership(A, user);
    clientId = await createClient(A, "Mock Client Kopi Senja");
    engagementId = newId();
    cycleId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, 'SCP-Se engagement', 'active')`, [engagementId, A, clientId]);
    await db.query(
      `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24', 'central')`,
      [cycleId, A, engagementId]);
  }, 120_000);
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.simulatedBoostMinutes = before.minutes;
    await teardownTestDb();
  });
  afterEach(() => {
    config.socialSimulationEnabled = true;
  });

  /** A live post and one boost of it. `startedMinutesAgo` is the age of `started_at`; `status` defaults to `running`. */
  async function makeBoost(o: { simulated: boolean; startedMinutesAgo?: number; status?: string; goal?: string }): Promise<string> {
    const postId = newId();
    const boostId = newId();
    const db = adminPool();
    await db.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at, simulated)
       VALUES ($1, $2, $3, $4, $5, 'live', now(), 'manual', 'https://simulated.invalid/p/mock', now() - interval '3 days', $6)`,
      [postId, A, engagementId, cycleId, `Mock boosted post ${++seq}`, o.simulated]);
    const status = o.status ?? "running";
    const started = status === "running" || status === "stopped";
    await db.query(
      `INSERT INTO social_boosts
         (id, tenant_id, post_id, client_id, cycle_id, status, goal, audience, daily_budget_minor, days, currency, starts_on,
          reach_estimate_low, reach_estimate_high, requested_by, approved_via, approved_by, approved_at, started_at, started_by,
          ended_at, spend_minor, simulated, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'automatic', 100000, 5, 'IDR', '2027-03-05', 10000, 30000, $8, 'portal', $8, now(),
               CASE WHEN $9::boolean THEN now() - ($10::numeric * interval '1 minute') ELSE NULL END,
               CASE WHEN $9::boolean THEN $8::uuid ELSE NULL END,
               CASE WHEN $6::text = 'stopped' THEN now() ELSE NULL END, CASE WHEN $6::text = 'stopped' THEN 123000 ELSE NULL END, $11, 'central')`,
      [boostId, A, postId, clientId, cycleId, status, o.goal ?? "website", user, started, o.startedMinutesAgo ?? 0, o.simulated]);
    return boostId;
  }
  const row = async (id: string) => (await adminPool().query(`SELECT * FROM social_boosts WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const activities = async (boostId: string) =>
    (await adminPool().query(
      `SELECT verb, actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = 'complete_boost' AND metadata->>'boostId' = $2`, [A, boostId],
    )).rows as Array<{ verb: string; actor_id: string | null; metadata: Record<string, unknown> }>;
  const sweep = (now = new Date(), o: Parameters<typeof runSimulatedBoostSweep>[1] = {}) => runSimulatedBoostSweep(now, { only: [A], minutes: WINDOW, ...o });

  it("(B1) completes a running simulated boost older than the window, once, with the generator's numbers", async () => {
    const id = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 5, goal: "website" });
    const r = await sweep();
    expect(r).toMatchObject({ skipped: false, completed: 1, errors: 0 });
    const want = simulatedBoostResult({
      boostId: id, dailyBudgetMinor: 100_000, days: 5, goal: "website", audience: "automatic", reachEstimateLow: 10_000, reachEstimateHigh: 30_000, minorUnit: 0,
    });
    const b = await row(id);
    expect(b.status).toBe("completed");
    expect(Number(b.spend_minor)).toBe(want.spendMinor);
    expect(Number(b.spend_minor)).toBeLessThanOrEqual(500_000);
    expect(b.paid_reach).toBe(want.paidReach);
    expect(b.clicks).toBe(want.clicks);
    expect(want.paidReach).toBeGreaterThanOrEqual(10_000);
    expect(want.paidReach).toBeLessThanOrEqual(30_000);
    expect(b.ended_at).not.toBeNull();
    expect(b.ended_by).toBeNull();
    expect(b.results_entered_by).toBeNull();
    const acts = await activities(id);
    expect(acts).toHaveLength(1);
    expect(acts[0].actor_id).toBeNull();
    expect(acts[0].metadata).toMatchObject({ viaSimulator: true, simulated: true, from: "running", to: "completed" });
  });

  it("(B2) a younger boost waits, then completes once the window has passed", async () => {
    const id = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW - 4 });
    const r1 = await sweep();
    expect(r1.completed).toBe(0);
    expect((await row(id)).status).toBe("running");
    expect(await activities(id)).toHaveLength(0);
    const r2 = await sweep(new Date(Date.now() + 5 * MIN));
    expect(r2.completed).toBe(1);
    expect((await row(id)).status).toBe("completed");
  });

  it("(B3) a real running boost is never touched, and the entry point refuses it", async () => {
    const id = await makeBoost({ simulated: false, startedMinutesAgo: 5_000 });
    const was = await row(id);
    const r = await sweep();
    expect(r).toMatchObject({ completed: 0, errors: 0 });
    const now = await row(id);
    expect(now.status).toBe("running");
    expect(now.spend_minor).toBeNull();
    expect(String(now.updated_at)).toBe(String(was.updated_at));
    expect(await activities(id)).toHaveLength(0);
    await expect(completeBoost(A, id, { spendMinor: 1, paidReach: 1, onlySimulated: true, expectedStatus: "running" })).rejects.toThrow(/not a simulated boost/);
    expect((await row(id)).status).toBe("running");
  });

  it("(B4) with the switch off nothing is read or written; back on, the same boost completes", async () => {
    const id = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 1 });
    config.socialSimulationEnabled = false;
    const off = await sweep();
    expect(off).toMatchObject({ skipped: true, tenants: 0, completed: 0, errors: 0 });
    expect((await row(id)).status).toBe("running");
    config.socialSimulationEnabled = true;
    expect((await sweep()).completed).toBe(1);
    expect((await row(id)).status).toBe("completed");
  });

  it("(B5) a rerun changes nothing; boosts that are not running are not selected; one that moved on is skipped, not an error", async () => {
    const id = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 1 });
    expect((await sweep()).completed).toBe(1);
    const done = await row(id);
    const again = await sweep();
    expect(again).toMatchObject({ completed: 0, moved: 0, errors: 0 });
    const after = await row(id);
    expect(String(after.updated_at)).toBe(String(done.updated_at));
    expect(await activities(id)).toHaveLength(1);

    const approved = await makeBoost({ simulated: true, status: "approved" });
    const stopped = await makeBoost({ simulated: true, status: "stopped", startedMinutesAgo: WINDOW + 30 });
    expect((await sweep()).completed).toBe(0);
    expect((await row(approved)).status).toBe("approved");
    expect((await row(stopped)).status).toBe("stopped");

    // Moved on after the selection: a person stops it before the job takes the lock. The stub stops it, then calls the real transition.
    const racing = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 1 });
    const r = await sweep(new Date(), {
      complete: async (t, b, o) => {
        await adminPool().query(`UPDATE social_boosts SET status = 'stopped', ended_at = now(), spend_minor = 1000 WHERE id = $1`, [b]);
        return completeBoost(t, b, { ...o, expectedStatus: "running" });
      },
    });
    expect(r).toMatchObject({ completed: 0, moved: 1, errors: 0 });
    expect((await row(racing)).status).toBe("stopped");
    expect(await activities(racing)).toHaveLength(0);
  });

  it("(B6) an error in one boost is counted and does not stop the next", async () => {
    const bad = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 40 });
    const good = await makeBoost({ simulated: true, startedMinutesAgo: WINDOW + 20 });
    const log = console.error;
    console.error = () => undefined;
    try {
      const r = await sweep(new Date(), {
        complete: async (t, b, o) => {
          if (b === bad) throw new Error("scp-boosts: complete_boost refused: not a simulated boost");
          return completeBoost(t, b, o);
        },
      });
      expect(r).toMatchObject({ completed: 1, errors: 1 });
    } finally {
      console.error = log;
    }
    expect((await row(bad)).status).toBe("running");
    expect((await row(good)).status).toBe("completed");
  });
});
