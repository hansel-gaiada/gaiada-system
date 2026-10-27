// SCP-Sc (plan §5: "A job publishes due variants every minute") — `social-simulated-due`: while the simulator runs, a simulated
// post goes live AT ITS SCHEDULED TIME, not at the next 15-minute safety poll.
//
// WHAT IT DOES. Every minute it finds the companies that hold QUEUED variants served by the simulator and runs the ordinary status
// reconcile for them (`post-status-sync-job.ts#reconcileTenantPostStatus`). That is all: the simulator's `getPostStatus` answers
// `published` for an id once its time has come, the reconcile's unchanged idempotent apply stamps the variant, and
// `pipeline/publisher-result.ts` makes the pipeline post live (or marks it failed). Nothing here publishes, mints or decides
// anything, and nothing here reaches the simulator: the reconcile is already one of the two on-ramps simulation.test.ts pins.
//
// ONLY WHILE THE SWITCH IS ON. `main.ts` starts the loop only with `SOCIAL_SIMULATION_ENABLED` on, and every tick re-reads the switch
// (`isSocialSimulationEnabled`, never cached): an operator's restart with the variable removed stops it, and a test that flips
// the flag stops the next sweep. With the switch off a sweep touches no table at all. (Simulated rows left behind with the switch
// off are not reconciled by the reconcile either: the simulator refuses `simulation_disabled` and they stay queued.)
//
// SHAPE mirrors `cycle-ready-by-job.ts` / `post-status-sync-job.ts`: `withGlobal` for the company list, per-company failures caught
// and logged so one company never stops the rest, ticks run one after another (the next is scheduled when the last ends, so a slow
// sweep never overlaps itself). The tenant filter is one indexed-enough EXISTS per company; the reconcile does the real work.
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { reconcileTenantPostStatus } from "./post-status-sync-job";
import { isSocialSimulationEnabled } from "./publisher/simulation";

/** The cadence: every minute (plan §5). */
export const SIMULATED_DUE_INTERVAL_MS = 60_000;

export interface SimulatedDueSweepResult {
  /** True when the switch was off and the sweep did nothing. */
  skipped: boolean;
  tenants: number;
  /** Companies that held queued simulated variants and were reconciled. */
  reconciled: number;
  applied: number;
  errors: number;
}

/** Does this company hold a variant the simulator served that is still waiting for its time? */
async function hasQueuedSimulatedVariants(tenantId: string): Promise<boolean> {
  const r = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return c.query(
      `SELECT 1 FROM social_post_variants
        WHERE simulated AND status IN ('queued', 'publishing') AND provider_post_id IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
    );
  });
  return (r.rowCount ?? 0) > 0;
}

/** One sweep across every company (`only`: just these companies, for a suite that shares a database with others). Does nothing (and
 *  reads nothing) with the switch off. */
export async function runSimulatedDueSweep(now: Date = new Date(), only?: string[]): Promise<SimulatedDueSweepResult> {
  const out: SimulatedDueSweepResult = { skipped: false, tenants: 0, reconciled: 0, applied: 0, errors: 0 };
  if (!isSocialSimulationEnabled()) return { ...out, skipped: true };
  const { rows: all } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`));
  const tenants = only ? all.filter((t) => only.includes(t.id)) : all;
  out.tenants = tenants.length;
  for (const { id: tenantId } of tenants) {
    try {
      if (!(await hasQueuedSimulatedVariants(tenantId))) continue;
      const r = await reconcileTenantPostStatus(tenantId, now);
      out.reconciled += 1;
      out.applied += r.applied;
      out.errors += r.errors;
    } catch (err) {
      out.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-SIMULATED-DUE] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return out;
}

/** The loop `main.ts` starts when the switch is on. The first sweep runs at once; each later one an interval after the last ended. */
export function startSimulatedDueLoop(intervalMs: number = SIMULATED_DUE_INTERVAL_MS): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runSimulatedDueSweep();
      // Quiet when there was nothing to do: this runs every minute.
      if (result.reconciled > 0 || result.errors > 0) {
        // eslint-disable-next-line no-console
        console.log("[SOCIAL-SIMULATED-DUE] sweep run:", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-SIMULATED-DUE] tick failed:", (err as Error).message);
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
