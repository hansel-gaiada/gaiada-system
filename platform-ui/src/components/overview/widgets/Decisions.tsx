import type { OverviewWidgetProps } from "./index";
import { readNowQueue } from "@/lib/overviewQueue";
import { companyAccess, decisionsView } from "@/lib/overviewCompany";
import { DecisionsBlock } from "./CompanyBlocks";

// DW-3i: "Needs you: decisions", the company Overview's Now block: the approvals and pipeline gates waiting in the active
// company, from the same shared work queue as the cockpit's Decisions tab (`getMyWorkQueue`, read once per request with Needs you
// and Today). Gate: the cockpit's console access (`gmAccessFor !== "none"`). The read throws only when no company could be
// read at all; a queue that did not include THIS company says "Unavailable", never "nothing is waiting".
export async function Decisions({ me, tenantId }: OverviewWidgetProps) {
  if (!companyAccess(me, tenantId).console) return null;
  const queue = await readNowQueue(me);
  return <DecisionsBlock view={decisionsView(queue, tenantId, new Date())} />;
}
