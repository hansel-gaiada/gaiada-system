import "server-only";
import { platformFetch, PlatformError } from "./platform";
import type { DeptKpisView, DeptKpiTargetsView } from "./deptKpiFormat";

export * from "./deptKpiFormat";

// Department KPIs (DW-4e-2): types, HONEST readers and pure formatters for the department KPI page
// (`/appraisals/department`), BFF contract §40 and §40.3a "as built" (docs/FRONTEND-BFF-CONTRACT.md).
//
// Values, targets and conditions come from the API and nowhere else: the catalogue, the condition rules and
// the suggested targets live on the server (`platform-nest/src/modules/reports/dept-kpis.ts`). This file only
// reads them and words them.
//
// ⚠ HONEST READERS. `getDeptKpis` and `getDeptKpiTargets` return a result union and never an empty list for a
// failure: "you may not read this", "this department does not exist" and "the read failed" are three different
// answers, and a department that looks healthy because its KPI read failed is the confident wrong answer this
// surface must never give (same rule as `getUnitCompliance` in lib/lms.ts, DW-4g).
//
// SCALES (§40.3a). `percent` values, targets and tolerances are FRACTIONS (0.85 = 85%). The UI shows and
// accepts whole percents (`toFraction` / `fromFraction`); the wire is always the fraction. `minutes` is a
// duration. `count` is a level.

export type DeptKpiReadResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "error"; reason: string };

export type DeptKpisResult = DeptKpiReadResult<DeptKpisView>;
export type DeptKpiTargetsResult = DeptKpiReadResult<DeptKpiTargetsView>;

const CONDITIONS: readonly string[] = ["on_track", "at_risk", "off_track", "unavailable"];

function fail<T>(e: unknown): DeptKpiReadResult<T> {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { kind: "forbidden" };
    // Only the typed 404 is "this department does not exist"; a bare 404 is the `reports` module being dark.
    if (e.status === 404 && (e.field === "unitNodeId" || e.message === "unit_not_found")) return { kind: "not_found" };
    return { kind: "error", reason: e.message };
  }
  return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
}

/** §40.3a unit read. Never degrades a failure to an empty list. */
export async function getDeptKpis(
  u: string, t: string, q: { unit: string; periodKind: string; start: string; end?: string },
): Promise<DeptKpisResult> {
  const qs = new URLSearchParams({ unitNodeId: q.unit, periodKind: q.periodKind, start: q.start });
  if (q.end) qs.set("end", q.end);
  try {
    const data = await platformFetch<DeptKpisView>(`/api/${t}/dept-kpis?${qs.toString()}`, u);
    if (
      !data || typeof data !== "object" || !Array.isArray(data.kpis) ||
      typeof data.condition !== "string" || !CONDITIONS.includes(data.condition) ||
      !data.unit || typeof data.unit.name !== "string"
    ) {
      return { kind: "error", reason: "unexpected answer from the department KPI endpoint" };
    }
    return { kind: "ok", data };
  } catch (e) {
    return fail(e);
  }
}

/** §40.3a targets list: each KPI's in-force row, open proposals and history. */
export async function getDeptKpiTargets(u: string, t: string, unit: string): Promise<DeptKpiTargetsResult> {
  try {
    const data = await platformFetch<DeptKpiTargetsView>(
      `/api/${t}/dept-kpis/targets?unitNodeId=${encodeURIComponent(unit)}`, u,
    );
    if (!data || typeof data !== "object" || !Array.isArray(data.kpis) || typeof data.asOf !== "string") {
      return { kind: "error", reason: "unexpected answer from the department KPI targets endpoint" };
    }
    return { kind: "ok", data };
  } catch (e) {
    return fail(e);
  }
}
