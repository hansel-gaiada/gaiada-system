import "server-only";
// SCP-5 W5-A6 (BFF §63.24.9): report automation's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person is not one of the four, which is not "no schedules";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asSchedules, type ReportSchedule } from "./socialReportSchedules";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET report-schedules` (`social_engagement` · `plan`): the company's schedules, oldest first, each with its last run and its spend. */
export function getReportSchedules(userId: string, tenantId: string): Promise<ReadResult<ReportSchedule[]>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/report-schedules`, userId).then(asSchedules));
}
