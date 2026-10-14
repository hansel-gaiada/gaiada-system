import type { OverviewWidgetProps } from "./index";
import { getMyAppraisals } from "@/lib/appraisals-data";
import { readResult } from "@/lib/readResult";
import { appraisalView } from "@/lib/overviewGrowth";
import { AppraisalBlock } from "./GrowthBlocks";
import { TeamAppraisals } from "./TeamWidgets";

// DW-3g: "Appraisal", the Growth band's second block: the person's current pack (not finalized) with their next step,
// and the last finalized result, from `GET appraisals/mine`. Note the reader's argument order: tenant first, then user.
//
// DW-3h: for a head in Team mode the same slot is "Team appraisals" (`TeamAppraisals`, the head's `GET appraisals`); Me mode is as it was.
export async function Appraisal(props: OverviewWidgetProps) {
  if (props.view === "team") return TeamAppraisals(props);
  const { me, tenantId } = props;
  return <AppraisalBlock view={appraisalView(await readResult(getMyAppraisals(tenantId, me.userId)))} />;
}
