import "server-only";
// DW-10c-3 (BFF §59.1): the department calendar's reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded; each leg of it says on its own whether it was read (`included`);
//   forbidden   a 403 (a unit outside the person's reporting line, or a client contact): they may not be told what is there;
//   unavailable anything else, a 404 (`unit_not_found`) and a 400 included: "cannot tell", never an empty calendar.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asDeptCalendar, type DeptCalendar } from "./deptCalendar";

/** `GET /api/:t/departments/:unitNodeId/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` (§59.1). The window is at most 42 days, both ends
 *  counted; the page asks for its six-week grid. */
export function getDeptCalendar(
  userId: string, tenantId: string, unitNodeId: string, window: { from: string; to: string },
): Promise<ReadResult<DeptCalendar>> {
  const q = new URLSearchParams({ from: window.from, to: window.to });
  const path = `/api/${encodeURIComponent(tenantId)}/departments/${encodeURIComponent(unitNodeId)}/calendar?${q.toString()}`;
  return readResult(platformFetch<unknown>(path, userId).then(asDeptCalendar));
}
