// P2-07 — nightly burndown-snapshot job (pm-console-ux-design-spec.md §4, §0 D-2). Best-effort
// pre-warmer: snapshots every tenant's every project once/day so a project nobody reads today
// still gets a data point. The LAZY upsert-on-read in pm.controller.ts's getBurndown() is the
// CORRECTNESS backstop — this job's failures are logged and swallowed per-tenant rather than
// aborting the whole sweep, and it is never required for the endpoint contract to hold.
//
// Env-gated + started from main.ts, following the same dark-by-default pattern as the n8n/graph
// bridges and the service-assignment drift sweep: it does not run unless explicitly turned on.
import { withGlobal, withTenants } from "../../db";
import { upsertTodaySnapshot } from "./pm.controller";

/** Snapshot every non-deleted project of every non-deleted company. Companies themselves carry
 *  no tenant_id (they ARE the tenants), so the company list is read via withGlobal; each
 *  company's projects are then snapshotted inside that company's own withTenants([tenantId])
 *  transaction (RLS-scoped, same contract as every other tenant-scoped write in this codebase). */
export async function runDailyBurndownSnapshot(): Promise<{ tenants: number; projects: number; errors: number }> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let projects = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      await withTenants([tenantId], async (c) => {
        const { rows: projectRows } = await c.query<{ id: string }>(
          `SELECT id FROM projects WHERE tenant_id = $1 AND deleted_at IS NULL`,
          [tenantId],
        );
        for (const { id: projectId } of projectRows) {
          await upsertTodaySnapshot(c, tenantId, projectId);
          projects += 1;
        }
      });
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[BURNDOWN-SNAPSHOT] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, projects, errors };
}

/** Daily loop. Only started by main.ts when config.pmBurndownSnapshotEnabled is set. */
export function startBurndownSnapshotLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runDailyBurndownSnapshot();
      if (result.errors > 0) {
        // eslint-disable-next-line no-console
        console.warn("[BURNDOWN-SNAPSHOT] completed with errors:", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[BURNDOWN-SNAPSHOT] tick failed:", (err as Error).message);
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
