import "server-only";
import { platformFetch, PlatformError } from "./platform";
import { isKpiDrivers, type KpiDrivers } from "./deptKpiDriverFormat";
import type { DeptKpiReadResult } from "./deptKpis";

export * from "./deptKpiDriverFormat";

// "Behind the miss" (DW-4j-3): the HONEST reader, BFF contract §43.8 and §43.8a "as built"
// (docs/FRONTEND-BFF-CONTRACT.md; the wire is `GET /api/:t/dept-kpis/drivers` in platform-nest/src/modules/reports/dept-kpi-watch.controller.ts).
//
// ⚠ A failed read is never an empty list. The reader returns the same four answers as `getDeptKpis`: ok (its `drivers` may truly be an
// empty array, "nothing missed", or null with a reason: "not measured yet"), forbidden (403 `outside your reporting line`: the read is for the
// unit's heads and the company-wide tiers, never the unit's staff), not_found (the typed 404 `unit_not_found`) and error (a bare 404, a 400
// such as a KPI that is not in the unit's set, a 5xx, a network failure, and an answer that is not the documented shape). A "behind the miss"
// list that looks empty because its read failed would say "no one stands out" about a KPI that is missing its target, so it is an error.
export type KpiDriversResult = DeptKpiReadResult<KpiDrivers>;

export interface KpiDriversQuery {
  unitNodeId: string;
  kpiKey: string;
  periodKind: string;
  start: string;
  end?: string;
}

function fail(e: unknown): KpiDriversResult {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { kind: "forbidden" };
    // Only the typed 404 is "this department does not exist"; a bare 404 is the `reports` module being dark.
    if (e.status === 404 && (e.field === "unitNodeId" || e.message === "unit_not_found")) return { kind: "not_found" };
    return { kind: "error", reason: e.message };
  }
  return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
}

/** §43.8: one KPI's drivers for a period, at most 5, worst first as the server sends them. */
export async function getKpiDrivers(u: string, t: string, q: KpiDriversQuery): Promise<KpiDriversResult> {
  const qs = new URLSearchParams({ unitNodeId: q.unitNodeId, kpiKey: q.kpiKey, periodKind: q.periodKind, start: q.start });
  if (q.end) qs.set("end", q.end);
  try {
    const data = await platformFetch<unknown>(`/api/${t}/dept-kpis/drivers?${qs.toString()}`, u);
    if (!isKpiDrivers(data)) return { kind: "error", reason: "unexpected answer from the KPI drivers endpoint" };
    return { kind: "ok", data };
  } catch (e) {
    return fail(e);
  }
}
