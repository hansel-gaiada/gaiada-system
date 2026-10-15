import "server-only";
// DW-7e: the honest payroll-run list, for the Overview's Pulse. `listPayrollRuns` (lib/hr-full.ts) is `soft(...)`, which
// turns a 403 and a 404 into `[]`; for a payroll tile that is the worst possible lie, "no run waits on anyone" about a
// viewer who may not even read payroll. This returns a `ReadResult` (403 `forbidden`, 404 and 5xx `unavailable`).
// The route needs the payroll read right (`hr_payroll`), so an HR person without it is told "No access".
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { PayrollRun, PayrollRunStatus } from "./hr-full";

export function listPayrollRunsResult(u: string, t: string, status?: PayrollRunStatus): Promise<ReadResult<PayrollRun[]>> {
  return readResult(platformFetch<PayrollRun[]>(`/api/${t}/modules/hr/payroll-runs${status ? `?status=${status}` : ""}`, u));
}
