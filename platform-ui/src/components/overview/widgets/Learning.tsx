import type { OverviewWidgetProps } from "./index";
import { getMyLearning } from "@/lib/lms";
import { readResult } from "@/lib/readResult";
import { learningView } from "@/lib/overviewGrowth";
import { LearningBlock } from "./GrowthBlocks";

// DW-3g: "Learning", the Growth band's first block: what is assigned to the signed-in person, what is overdue and what
// falls due next, from `GET lms/me`. `getMyLearning` rethrows on purpose; `readResult` turns that into data here so a
// refused read says "No access" and a failed one "Unavailable", never "nothing assigned".
export async function Learning({ me, tenantId }: OverviewWidgetProps) {
  return <LearningBlock view={learningView(await readResult(getMyLearning(me.userId, tenantId)))} />;
}
