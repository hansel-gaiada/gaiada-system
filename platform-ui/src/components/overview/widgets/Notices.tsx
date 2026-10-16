import type { OverviewWidgetProps } from "./index";
import { listNotices } from "@/lib/notices-data";
import { BLOCK_NOTICES_MAX, NOTICES_COMPANY_HREF, mayPostNotice, noticesUnitHref } from "@/lib/notices";
import { noticesBlockView } from "@/lib/overviewNotices";
import { NoticesBlock } from "./NoticesBlock";

// DW-10a-2: "Notices", the Now band's third block (BFF §57.8): what the unit's head, the units above it and the company want this person to know.
// Reads `GET /notices?unitNodeId=<the workspace's node>&state=current` for the first few (the server answers pinned first), so a slow or failing
// read costs only this block. The frame does not place it in a workspace with no node (`noticesWidgetPlaced`). Whether the person is OFFERED
// "Post a notice" is a mirror (`mayPostNotice`); the board's form and the server decide the write.
export async function Notices({ me, tenantId, deptId, unitPath }: OverviewWidgetProps) {
  if (!deptId) return null;
  const result = await listNotices(me.userId, tenantId, { unitNodeId: deptId }, { state: "current", limit: BLOCK_NOTICES_MAX });
  const view = noticesBlockView(result, mayPostNotice(me, tenantId, unitPath), deptId);
  return <NoticesBlock view={view} title="Notices" allHref={noticesUnitHref(deptId)} />;
}

/** The company Overview's block (`company-notices`): the company-wide notices only, never narrowed to a department, whatever node the frame
 *  carries (the Office of the GM is a workspace with a node of its own). Posting here is a company admin's alone. */
export async function CompanyNotices({ me, tenantId }: OverviewWidgetProps) {
  const result = await listNotices(me.userId, tenantId, { scope: "company" }, { state: "current", limit: BLOCK_NOTICES_MAX });
  const view = noticesBlockView(result, mayPostNotice(me, tenantId, null), null);
  return <NoticesBlock view={view} title="Company notices" allHref={NOTICES_COMPANY_HREF} />;
}
