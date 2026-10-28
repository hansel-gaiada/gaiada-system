// SCP-Se (plan §5 "Simulated boosts": "A started boost completes after a short, configurable time, with spend at or below budget, paid
// reach and clicks") — `social-simulated-boost`: while the simulator runs, a SIMULATED boost that staff started finishes by itself.
//
// WHAT IT DOES. Every minute, for each company, it takes the `running` boosts marked `simulated` whose `started_at` is older than
// `SOCIAL_SIMULATED_BOOST_MINUTES` (config.social.simulatedBoostMinutes, default 10) and completes each through
// `pipeline/boosts.ts#completeBoost` with the numbers `publisher/simulated-boost.ts` draws for it. `completeBoost` is the route's own
// transition (cycle lock, row lock, the fixture's `from`), writes the activity row with actor NULL and `metadata.viaSimulator`, and
// so the cycle's committed money, the Boosting list and the client's notices see a simulated boost end exactly as a real one does.
//
// WHAT IT NEVER DOES.
//   - It never STARTS a boost: staff start it (the plan's flow is request, approve, start by a person, then the simulator ends it).
//   - It never touches a REAL boost. The selection says `simulated = true`, and the entry point is called with `onlySimulated: true`,
//     which THROWS on a real boost: a second, independent fence (the boost's mark is copied from its post, a post being wholly simulated
//     or wholly real). If that throw ever happens it is counted and logged as an ERROR and never retried as real; the next tick will
//     pick the same row up again only if the selection still names it, which it cannot for a real one.
//   - It never completes twice. Each completion passes `expectedStatus: "running"`, so a boost a person stopped, cancelled or completed
//     in the meantime answers 409 `boost_status_changed` under the cycle lock and is SKIPPED (counted as `skipped`, not an error). A rerun
//     over a completed boost finds nothing: the selection is `status = 'running'`.
//   - It never runs with the switch off: `main.ts` starts the loop only while SOCIAL_SIMULATION_ENABLED is on, and every sweep re-reads
//     the switch (`isSocialSimulationEnabled`, never cached), so a test that flips the flag, or an operator's restart without it, stops
//     the next sweep. With the switch off a sweep reads no table at all.
//
// SHAPE mirrors `simulated-due-job.ts`: `withGlobal` for the company list, a failure in one company or one boost is caught and logged so
// it never stops the rest, and ticks run one after another (the next is scheduled when the last ends, so a slow sweep never overlaps
// itself). At most BATCH boosts per company per tick, oldest first; the rest wait for the next minute.
import { withGlobal, withTenants } from "../../db";
import { completeBoost } from "./pipeline/boosts";
import { minorUnitSql } from "./pipeline/boosts-data";
import { config } from "../../config";
import { isSocialSimulationEnabled } from "./publisher/simulation";
import { simulatedBoostResult, type SimulatedBoostFacts } from "./publisher/simulated-boost";

/** The cadence: every minute (plan §5). */
export const SIMULATED_BOOST_INTERVAL_MS = 60_000;
/** The most boosts one company completes in one tick. */
export const SIMULATED_BOOST_BATCH = 50;

const SOCIAL = { modules: ["social"] };

export interface SimulatedBoostSweepResult {
  /** True when the switch was off and the sweep did nothing. */
  skipped: boolean;
  tenants: number;
  /** Boosts completed by this sweep. */
  completed: number;
  /** Boosts that had moved on by the time the lock was taken (409 `boost_status_changed`): left alone. */
  moved: number;
  /** Real boosts refused by the entry point, and any other failure. */
  errors: number;
}

interface DueRow {
  id: string; daily_budget_minor: string; days: number; goal: string; audience: string;
  reach_estimate_low: number | null; reach_estimate_high: number | null; minor_unit: number;
}

/** The simulated boosts of one company that have been running for at least `minutes`, oldest first. */
async function dueBoosts(tenantId: string, cutoff: Date): Promise<DueRow[]> {
  const r = await withTenants([tenantId], (c) => c.query<DueRow>(
    `SELECT b.id::text AS id, b.daily_budget_minor::text AS daily_budget_minor, b.days, b.goal, b.audience,
            b.reach_estimate_low, b.reach_estimate_high, ${minorUnitSql("b.currency")} AS minor_unit
       FROM social_boosts b
      WHERE b.tenant_id = $1 AND b.status = 'running' AND b.simulated AND b.started_at IS NOT NULL AND b.started_at <= $2
      ORDER BY b.started_at, b.id LIMIT ${SIMULATED_BOOST_BATCH}`,
    [tenantId, cutoff]), SOCIAL);
  return r.rows;
}

export interface SimulatedBoostSweepOptions {
  /** The window in minutes; defaults to `config.social.simulatedBoostMinutes`, read at call time. */
  minutes?: number;
  /** Just these companies, for a suite that shares a database with others. */
  only?: string[];
  /** The completion call; defaults to `completeBoost`. A test passes a throwing one to prove the error path. */
  complete?: typeof completeBoost;
}

/** One sweep across every company. Does nothing (and reads nothing) with the switch off. */
export async function runSimulatedBoostSweep(now: Date = new Date(), o: SimulatedBoostSweepOptions = {}): Promise<SimulatedBoostSweepResult> {
  const out: SimulatedBoostSweepResult = { skipped: false, tenants: 0, completed: 0, moved: 0, errors: 0 };
  if (!isSocialSimulationEnabled()) return { ...out, skipped: true };
  const minutes = o.minutes ?? config.social.simulatedBoostMinutes;
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const complete = o.complete ?? completeBoost;
  const { rows: all } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`));
  const tenants = o.only ? all.filter((t) => o.only!.includes(t.id)) : all;
  out.tenants = tenants.length;
  for (const { id: tenantId } of tenants) {
    let due: DueRow[];
    try {
      due = await dueBoosts(tenantId, cutoff);
    } catch (err) {
      out.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-SIMULATED-BOOST] tenant ${tenantId} failed:`, (err as Error).message);
      continue;
    }
    for (const b of due) {
      const facts: SimulatedBoostFacts = {
        boostId: b.id, dailyBudgetMinor: Number(b.daily_budget_minor), days: b.days, goal: b.goal, audience: b.audience,
        reachEstimateLow: b.reach_estimate_low, reachEstimateHigh: b.reach_estimate_high, minorUnit: b.minor_unit,
      };
      const res = simulatedBoostResult(facts);
      try {
        const r = await complete(tenantId, b.id, { ...res, onlySimulated: true, expectedStatus: "running" });
        if (r.applied) out.completed += 1;
        else out.moved += 1;
      } catch (err) {
        const status = (err as { getStatus?: () => number }).getStatus?.();
        const code = (err as { getResponse?: () => { message?: string } }).getResponse?.()?.message;
        if (status === 409 && (code === "boost_status_changed" || code === "invalid_boost_transition")) {
          out.moved += 1;
          continue;
        }
        out.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[SOCIAL-SIMULATED-BOOST] boost ${b.id} (tenant ${tenantId}) failed, not retried as real:`, (err as Error).message);
      }
    }
  }
  return out;
}

/** The loop `main.ts` starts when the switch is on. The first sweep runs at once; each later one an interval after the last ended. */
export function startSimulatedBoostLoop(intervalMs: number = SIMULATED_BOOST_INTERVAL_MS): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runSimulatedBoostSweep();
      // Quiet when there was nothing to do: this runs every minute.
      if (result.completed > 0 || result.moved > 0 || result.errors > 0) {
        // eslint-disable-next-line no-console
        console.log("[SOCIAL-SIMULATED-BOOST] sweep run:", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-SIMULATED-BOOST] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
