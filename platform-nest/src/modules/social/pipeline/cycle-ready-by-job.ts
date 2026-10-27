// SCP-1c — `social-cycle-ready-by`: the nightly recompute of every open cycle's `ready_by` (BFF §63.1: "recomputed by every write to the
// cycle or to the buffer, and nightly by `social-cycle-ready-by` (holiday changes)").
//
// WHY A JOB. `ready_by` is stored (it is what the deadline table, the Team dashboard and the content-month task's due date read), and
// it is the deadline less the buffer in WORKING days. The HR holiday calendar changes under it (a joint-leave day is added, a public
// holiday moved), and nothing writes the cycle when it does. The sweep brings every open cycle back in line, writing only a value that
// changed. An open cycle is one whose content month has not ended (`OPEN_CYCLE_SQL`).
//
// SHAPE mirrors `best-time-job.ts` / `content-brief-sweep-job.ts`: `withGlobal` for the company list, per-company failures caught and
// logged so one bad company never stops the rest, a `start…Loop` that `main.ts` calls only when the flag is on. It is DARK BY DEFAULT,
// like every other sweep in this module (`config.social.cycleReadyBy.enabled`, env `SOCIAL_CYCLE_READY_BY_ENABLED`): it spends nothing
// (no gateway call), so this is the house default rather than a safety gate. Every write is also made by the routes that move a
// deadline or the buffer, so a company that never switches the job on only misses holiday-driven drift.
//
// The job acts as no person: it leaves `updated_by` as the last person's write set it (`COALESCE` in `recomputeOpenReadyBy`). It reads
// and writes only the company's own rows, in the company's own scope.
import { withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";
import {
  READY_BY_LOOKBACK_DAYS, loadCalendarInfo, openCycleDeadlineRange, readSettings, recomputeOpenReadyBy, todayIsoInTz,
} from "./cycles-data";

export interface CycleReadyBySweepResult {
  tenants: number;
  /** Companies with at least one open cycle. */
  tenantsWithOpenCycles: number;
  cyclesChecked: number;
  cyclesUpdated: number;
  /** Cycles whose deadline lay outside the holiday window that was read (they are caught by the next run). */
  cyclesSkipped: number;
  errors: number;
}

/** One company: read its open cycles' deadline range and buffer, read the holidays over that range, recompute in one transaction. */
export async function refreshReadyByForTenant(tenantId: string, today: string): Promise<{ checked: number; updated: number; skipped: number } | null> {
  const head = await withTenants(
    [tenantId],
    async (c) => ({ range: await openCycleDeadlineRange(c, tenantId, today), settings: await readSettings(c, tenantId) }),
    { modules: ["social"] },
  );
  if (!head.range) return null;
  const info = await loadCalendarInfo(tenantId, [head.range.min, head.range.max, today], READY_BY_LOOKBACK_DAYS);
  const range = head.range;
  return withTenants(
    [tenantId],
    (c) => recomputeOpenReadyBy(c, { tenantId, today, bufferWorkingDays: head.settings.bufferWorkingDays, calendar: info.calendar, range, actorId: null }),
    { modules: ["social"] },
  );
}

/** One sweep across every company. */
export async function runCycleReadyBySweep(now: Date = new Date()): Promise<CycleReadyBySweepResult> {
  const today = todayIsoInTz(config.reportsTz, now);
  const { rows: tenants } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`));
  const out: CycleReadyBySweepResult = { tenants: tenants.length, tenantsWithOpenCycles: 0, cyclesChecked: 0, cyclesUpdated: 0, cyclesSkipped: 0, errors: 0 };
  for (const { id: tenantId } of tenants) {
    try {
      const r = await refreshReadyByForTenant(tenantId, today);
      if (!r) continue;
      out.tenantsWithOpenCycles += 1;
      out.cyclesChecked += r.checked;
      out.cyclesUpdated += r.updated;
      out.cyclesSkipped += r.skipped;
    } catch (err) {
      out.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-CYCLE-READY-BY] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return out;
}

/** Nightly (default) loop. Only started by `main.ts` when `config.social.cycleReadyBy.enabled` is true. */
export function startCycleReadyByLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runCycleReadyBySweep();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-CYCLE-READY-BY] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-CYCLE-READY-BY] tick failed:", (err as Error).message);
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
