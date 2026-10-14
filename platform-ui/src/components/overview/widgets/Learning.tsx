import type { OverviewWidgetProps } from "./index";
import { getMyLearning } from "@/lib/lms";
import { readResult } from "@/lib/readResult";
import { learningView } from "@/lib/overviewGrowth";
import { LearningBlock } from "./GrowthBlocks";
import { TeamLearning } from "./TeamWidgets";

// DW-3g: "Learning", the Growth band's first block: what is assigned to the signed-in person, what is overdue and what
// falls due next, from `GET lms/me`. `getMyLearning` rethrows on purpose; `readResult` turns that into data here so a
// refused read says "No access" and a failed one "Unavailable", never "nothing assigned".
//
// DW-3h: for a head in Team mode the same slot is "Team learning" (`TeamLearning`, `lms compliance?unit=`); Me mode is as it was.
export async function Learning(props: OverviewWidgetProps) {
  if (props.view === "team") return TeamLearning(props);
  const { me, tenantId } = props;
  return <LearningBlock view={learningView(await readResult(getMyLearning(me.userId, tenantId)))} />;
}
