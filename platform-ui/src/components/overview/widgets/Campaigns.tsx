import type { OverviewWidgetProps } from "./index";
import { readSharedCampaigns } from "@/lib/campaigns-data";
import { campaignsView } from "@/lib/overviewWork";
import { CampaignsBlock } from "./WorkBlocks";

// DW-3f: "Campaigns", the Work band's block: the shared campaigns the department has a part in, with OUR part's status
// (`GET campaigns?unitId=`, an honest reader). The registry gates it to the agency pack. A failed read says
// "Unavailable", a refused one "No access"; only a successful read can say "No shared campaigns".
export async function Campaigns({ me, tenantId, deptId, workLinks }: OverviewWidgetProps) {
  if (!deptId) return null;
  const view = campaignsView(await readSharedCampaigns(me.userId, tenantId, deptId), deptId);
  return <CampaignsBlock view={view} href={workLinks?.campaigns ?? null} />;
}
