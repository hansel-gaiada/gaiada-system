import type { OverviewWidgetProps } from "./index";
import { getCompanyCompliance } from "@/lib/lms";
import { readResult } from "@/lib/readResult";
import { companyAccess, companyLearningView } from "@/lib/overviewCompany";
import { CompanyLearningBlock } from "./CompanyBlocks";

// DW-3i: "Learning compliance", the company Overview's Growth block: mandatory training, completed over assigned across the
// company (`GET lms/compliance`, the company-wide grid; BFF §38: without `unit` the endpoint is unchanged). `getCompanyCompliance`
// rethrows; `readResult` turns that into data so a refusal says "No access" and a failure "Unavailable", never "nothing assigned".
// Placed for the cockpit's "full" access that also holds `lms.progress.view`; the lms module gate is `growthWidgetPlaced`.
export async function CompanyLearning({ me, tenantId }: OverviewWidgetProps) {
  if (!companyAccess(me, tenantId).numbers) return null;
  return <CompanyLearningBlock view={companyLearningView(await readResult(getCompanyCompliance(me.userId, tenantId)))} href="/learning/compliance" />;
}
