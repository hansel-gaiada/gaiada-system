import "server-only";
import { platformFetch, PlatformError } from "./platform";
import { getAppraisalCycles } from "./appraisals-data";
import { sortCyclesNewestFirst, type CyclePick, type DeptAppraisalView } from "./deptAppraisalFormat";

export * from "./deptAppraisalFormat";

// The department appraisal per cycle (DW-4e-3): HONEST readers for the department page's cycle view, BFF contract §41.
//
// ⚠ HONEST READERS, the same rule as lib/deptKpis.ts. Each reader returns a result union and never an empty answer for a
// failure: "you may not read this", "this department / cycle does not exist" and "the read failed" are different answers, and
// a department appraisal that looks blank because the read failed is the confident wrong answer this surface must never give.
//
// THE CYCLE LIST is the existing appraisal cycles reader (`GET /appraisals/cycles`), which the server gives to the
// appraisal administrators only (`cycle_admin`). Anyone else gets `forbidden` here, and the page says so rather than showing
// an empty picker; a cycle they can read is still reachable by its `?cycle=` link.

export type DeptAppraisalReadResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "forbidden" }
  | { kind: "not_found"; what: "unit" | "cycle" }
  | { kind: "error"; reason: string };

export type DeptAppraisalResult = DeptAppraisalReadResult<DeptAppraisalView>;
export type CycleListResult = { kind: "ok"; data: CyclePick[] } | { kind: "forbidden" } | { kind: "error"; reason: string };

const CONDITIONS: readonly string[] = ["on_track", "at_risk", "off_track", "unavailable"];

function fail(e: unknown): DeptAppraisalReadResult<never> {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { kind: "forbidden" };
    // Only the typed 404s are "does not exist"; a bare 404 is the `reports` module being dark.
    if (e.status === 404 && (e.field === "cycleId" || e.message === "cycle_not_found")) return { kind: "not_found", what: "cycle" };
    if (e.status === 404 && (e.field === "unitNodeId" || e.message === "unit_not_found")) return { kind: "not_found", what: "unit" };
    return { kind: "error", reason: e.message };
  }
  return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
}

/** §41.4 read. Never degrades a failure to an empty view. */
export async function getDeptAppraisal(u: string, t: string, q: { unit: string; cycleId: string }): Promise<DeptAppraisalResult> {
  const qs = new URLSearchParams({ cycleId: q.cycleId, unitNodeId: q.unit });
  try {
    const data = await platformFetch<DeptAppraisalView>(`/api/${t}/dept-appraisals?${qs.toString()}`, u);
    if (
      !data || typeof data !== "object" || !data.cycle || typeof data.cycle.id !== "string" ||
      !Array.isArray(data.kpis) || !Array.isArray(data.history) || !data.people || typeof data.people.total !== "number" ||
      typeof data.condition !== "string" || !CONDITIONS.includes(data.condition) || !data.unit || typeof data.unit.name !== "string"
    ) {
      return { kind: "error", reason: "unexpected answer from the department appraisal endpoint" };
    }
    return { kind: "ok", data };
  } catch (e) {
    return fail(e);
  }
}

/** The company's cycles, newest first, for the picker. `forbidden` for anyone who is not an appraisal administrator. */
export async function getCyclePicks(u: string, t: string): Promise<CycleListResult> {
  try {
    const res = await getAppraisalCycles(t, u);
    if (!res || !Array.isArray(res.cycles)) return { kind: "error", reason: "unexpected answer from the appraisal cycles endpoint" };
    return {
      kind: "ok",
      data: sortCyclesNewestFirst(
        res.cycles.map((c) => ({ id: c.id, name: c.name, periodStart: c.periodStart, periodEnd: c.periodEnd, status: c.status })),
      ),
    };
  } catch (e) {
    if (e instanceof PlatformError) return e.status === 403 ? { kind: "forbidden" } : { kind: "error", reason: e.message };
    return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
  }
}
