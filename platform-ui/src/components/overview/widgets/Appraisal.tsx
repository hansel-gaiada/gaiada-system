import type { OverviewWidgetProps } from "./index";
import { getMyAppraisals } from "@/lib/appraisals-data";
import { readResult } from "@/lib/readResult";
import { appraisalView } from "@/lib/overviewGrowth";
import { AppraisalBlock } from "./GrowthBlocks";

// DW-3g: "Appraisal", the Growth band's second block: the person's current pack (not finalized) with their next step,
// and the last finalized result, from `GET appraisals/mine`. Note the reader's argument order: tenant first, then user.
export async function Appraisal({ me, tenantId }: OverviewWidgetProps) {
  return <AppraisalBlock view={appraisalView(await readResult(getMyAppraisals(tenantId, me.userId)))} />;
}
