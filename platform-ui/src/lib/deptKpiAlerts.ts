import "server-only";
import { platformFetch, PlatformError } from "./platform";
import { isKpiAlert, type KpiAlert } from "./deptKpiAlertFormat";
import type { DeptKpiReadResult } from "./deptKpis";

export * from "./deptKpiAlertFormat";

// Department KPI alerts (DW-4j-2): the HONEST readers, BFF contract §43.5 and §43.6a "as built"
// (docs/FRONTEND-BFF-CONTRACT.md; the wire is platform-nest/src/modules/reports/dept-kpi-watch.controller.ts).
//
// ⚠ A failed read is never an empty list. Both readers return a result union with the same four answers as `getDeptKpis`:
// ok (a list that may truly be empty: "you head no unit" and "this unit has no alerts" are TRUE), forbidden, not_found and
// error. An alerts list that looks empty because its read failed would say "nothing is off track" on a surface whose whole
// job is to say the opposite.
//
// `getMyKpiAlerts` (no `unitNodeId`) is the Needs-you source: the open, unacknowledged alerts of the units the CALLER heads
// (§43.1's exact-node rule, applied to the caller). It is personal, so a company-wide caller who heads nothing gets an honest
// `ok` with no rows. A BARE 404 here (no typed field) is the `reports` module being dark for the company: the source does not
// exist there, which is `not_found` (the queue reads it as "no alerts source in this company", not as a lost source).
// `getUnitKpiAlerts` (`?unitNodeId=`) is one unit's whole history under the unit read's gate (§40.3a): there a typed 404
// (`unit_not_found`) is `not_found`, and a bare 404 is an `error`, as in `getDeptKpis`.

export type KpiAlertsResult = DeptKpiReadResult<KpiAlert[]>;

function fail(e: unknown, bare404: "not_found" | "error"): KpiAlertsResult {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { kind: "forbidden" };
    if (e.status === 404) {
      if (e.field === "unitNodeId" || e.message === "unit_not_found") return { kind: "not_found" };
      return bare404 === "not_found" ? { kind: "not_found" } : { kind: "error", reason: e.message };
    }
    return { kind: "error", reason: e.message };
  }
  return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
}

async function read(u: string, path: string, bare404: "not_found" | "error"): Promise<KpiAlertsResult> {
  try {
    const data = await platformFetch<{ alerts?: unknown }>(path, u);
    if (!data || typeof data !== "object" || !Array.isArray(data.alerts) || !data.alerts.every(isKpiAlert)) {
      return { kind: "error", reason: "unexpected answer from the KPI alerts endpoint" };
    }
    return { kind: "ok", data: data.alerts };
  } catch (e) {
    return fail(e, bare404);
  }
}

/** The caller's open, unacknowledged alerts: the units they head (§43.5). The Needs-you source. */
export async function getMyKpiAlerts(u: string, t: string): Promise<KpiAlertsResult> {
  return read(u, `/api/${t}/dept-kpis/alerts`, "not_found");
}

/** One unit's alerts, open and resolved, newest first, up to 100 (§43.5), under the unit read's gate. */
export async function getUnitKpiAlerts(u: string, t: string, unitNodeId: string): Promise<KpiAlertsResult> {
  return read(u, `/api/${t}/dept-kpis/alerts?unitNodeId=${encodeURIComponent(unitNodeId)}`, "error");
}
