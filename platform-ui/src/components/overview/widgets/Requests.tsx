import type { OverviewWidgetProps } from "./index";
import { readRequestSummary } from "@/lib/requests-data";
import { requestsView } from "@/lib/overviewWork";
import { RequestsBlock } from "./WorkBlocks";

// DW-3f: "Requests", the Work band's block: what waits on the department (incoming, with the oldest one's age) and what
// it is waiting on (sent), from `GET requests/summary`. A count comes only from a successful read; a failed one says
// "Unavailable", a refused one "No access", never 0. Each count links to its tab where the workspace has that tab.
export async function Requests({ me, tenantId, deptId, workLinks }: OverviewWidgetProps) {
  if (!deptId) return null;
  const view = requestsView(await readRequestSummary(me.userId, tenantId, deptId), new Date());
  return <RequestsBlock view={view} incomingHref={workLinks?.requestsIncoming ?? null} sentHref={workLinks?.requestsSent ?? null} />;
}
