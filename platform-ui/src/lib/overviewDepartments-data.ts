import "server-only";
// DW-3i: the reader behind the company Overview's "Departments by condition" (BFF §40.3, §40.3a):
// `GET /api/:t/dept-kpis/overview?periodKind&start` answers every department of the company with its condition, worst first.
// Only the company-wide tiers may read it; anyone else gets 403, which `readResult` turns into `forbidden`.
//
// Honest by construction: a 403 is `forbidden`, every other failure is `unavailable`, and an answer that is not the §40 shape
// (a backend older than DW-4e-1) is a failure too. Nothing here ever becomes an empty list of departments.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { normalizeDeptKpiOverview, type DeptKpiOverview } from "./overviewDepartments";
import type { ReportPeriodKind } from "./reports";

export function readDeptKpiOverview(userId: string, tenantId: string, periodKind: ReportPeriodKind, start: string): Promise<ReadResult<DeptKpiOverview>> {
  const qs = new URLSearchParams({ periodKind, start });
  return readResult(
    platformFetch<unknown>(`/api/${tenantId}/dept-kpis/overview?${qs.toString()}`, userId).then((raw) => {
      const overview = normalizeDeptKpiOverview(raw);
      if (!overview) throw new Error("The department standing read returned an unexpected answer.");
      return overview;
    }),
  );
}
