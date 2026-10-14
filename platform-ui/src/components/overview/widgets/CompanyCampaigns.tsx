import type { OverviewWidgetProps } from "./index";
import { readAllCampaigns } from "@/lib/campaigns-data";
import { companyCampaignsView } from "@/lib/overviewCompany";
import { CompanyCampaignsBlock } from "./CompanyBlocks";

// DW-3i: "Campaigns" across departments, the company Overview's Work block: the company's open campaigns with how many
// departments have a part in each (`GET campaigns`, BFF §31.4), the soonest ending first. The registry gates it as the cockpit's
// Campaigns row (`agencyRow: agency`). A failed read says "Unavailable", a refused one "No access"; only a successful read can say
// "No open campaigns".
export async function CompanyCampaigns({ me, tenantId }: OverviewWidgetProps) {
  return <CompanyCampaignsBlock view={companyCampaignsView(await readAllCampaigns(me.userId, tenantId))} />;
}
