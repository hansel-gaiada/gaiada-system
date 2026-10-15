import "server-only";
// DW-7e: HR's honest list readers, for the Overview's Pulse tiles. `listLeave` and `listCases` (lib/hr.ts) turn a 403
// and a 404 into `[]`, which their pages want and a count cannot use: a refused read would be a tile that says 0. These
// return a `ReadResult`, so a 403 is `forbidden` and a 404 or 5xx is `unavailable`, and only a real 200 can be a count.
//
// No `absentAsEmpty`: a 404 here is the `hr` module not served for this company, and a tile in HR's workspace has no
// business saying "0 pending" about a module that is not there.
//
// NOTE what the server does with a viewer who may not read the whole company: `GET /leave` and `GET /cases` fall back to
// the viewer's OWN rows (`staffOrSelfRead`) instead of refusing. The count of that read is not the department's number,
// so the caller (the Pulse) only reads these for a viewer in the HR scope (`hrScopeCompanies`).
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { HrCase, HrCaseKind, HrCaseStatus, HrLeaveRequest, LeaveStatus } from "./hr";

function query(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
}

export function listLeaveResult(u: string, t: string, q: { status?: LeaveStatus } = {}): Promise<ReadResult<HrLeaveRequest[]>> {
  return readResult(platformFetch<HrLeaveRequest[]>(`/api/${t}/modules/hr/leave${query({ status: q.status })}`, u));
}

export function listCasesResult(u: string, t: string, q: { kind?: HrCaseKind; status?: HrCaseStatus } = {}): Promise<ReadResult<HrCase[]>> {
  return readResult(platformFetch<HrCase[]>(`/api/${t}/modules/hr/cases${query({ kind: q.kind, status: q.status })}`, u));
}
