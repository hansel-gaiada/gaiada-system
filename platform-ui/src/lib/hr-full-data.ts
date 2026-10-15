import "server-only";
// DW-7e: the honest payroll-run list, for the Overview's Pulse. `listPayrollRuns` (lib/hr-full.ts) is `soft(...)`, which
// turns a 403 and a 404 into `[]`; for a payroll tile that is the worst possible lie, "no run waits on anyone" about a
// viewer who may not even read payroll. This returns a `ReadResult` (403 `forbidden`, 404 and 5xx `unavailable`).
// The route needs the payroll read right (`hr_payroll`), so an HR person without it is told "No access".
import { platformFetch, PlatformError } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { PayrollInput, PayrollRun, PayrollRunDetail, PayrollRunStatus } from "./hr-full";
import type { Employee } from "./iam";

export function listPayrollRunsResult(u: string, t: string, status?: PayrollRunStatus): Promise<ReadResult<PayrollRun[]>> {
  return readResult(platformFetch<PayrollRun[]>(`/api/${t}/modules/hr/payroll-runs${status ? `?status=${status}` : ""}`, u));
}

// DW-7f-1b: ONE payroll run with its payslips, for /hr/payroll/[runId]. `getPayrollRun` throws on every failure, which a
// page cannot tell apart. Here a 404 on the single item is a real answer (`ok` with null: no such run, the page calls
// notFound()), a 403 is `forbidden`, and anything else is `unavailable`.
export async function getPayrollRunResult(u: string, t: string, id: string): Promise<ReadResult<PayrollRunDetail | null>> {
  try {
    return { kind: "ok", data: await platformFetch<PayrollRunDetail>(`/api/${t}/modules/hr/payroll-runs/${encodeURIComponent(id)}`, u) };
  } catch (err) {
    if (err instanceof PlatformError && err.status === 404) return { kind: "ok", data: null };
    return readResult(Promise.reject(err));
  }
}

// DW-7f-1b: the employees an input can be raised for. lib/iam `listEmployees` degrades a refusal to [], which on a picker
// reads as "there are no employees"; this keeps the refusal. Route `GET /api/:t/hr/employees` (employee `read`, not the
// payroll gate), so a payroll manager can be refused here while allowed everything else.
export function listEmployeesResult(u: string, t: string): Promise<ReadResult<Employee[]>> {
  return readResult(platformFetch<{ employees?: Employee[] }>(`/api/${t}/hr/employees`, u).then((r) => r.employees ?? []));
}

// DW-7f-1c (BFF §50): the payroll inputs already entered. Route `GET /api/:t/modules/hr/payroll-inputs`, authorized as
// `hr_payroll` read like the run list, so a refusal is common and must read as one: 403 is `forbidden`, 404 and 5xx are
// `unavailable`. An empty `data` is the server's own answer "no such inputs". `consumed: false` is "waiting for the next
// calculate"; `runId` is what that run consumed. Absent filters are left off the query.
export function listPayrollInputsResult(
  u: string, t: string,
  filter: { runId?: string; employeeId?: string; periodStart?: string; periodEnd?: string; consumed?: boolean } = {},
): Promise<ReadResult<PayrollInput[]>> {
  const qs = new URLSearchParams();
  if (filter.runId) qs.set("runId", filter.runId);
  if (filter.employeeId) qs.set("employeeId", filter.employeeId);
  if (filter.periodStart) qs.set("periodStart", filter.periodStart);
  if (filter.periodEnd) qs.set("periodEnd", filter.periodEnd);
  if (filter.consumed !== undefined) qs.set("consumed", String(filter.consumed));
  const q = qs.toString();
  return readResult(platformFetch<PayrollInput[]>(`/api/${t}/modules/hr/payroll-inputs${q ? `?${q}` : ""}`, u));
}
