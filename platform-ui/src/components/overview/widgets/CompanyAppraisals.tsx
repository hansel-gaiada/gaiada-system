import type { OverviewWidgetProps } from "./index";
import { listAppraisals } from "@/lib/appraisals-data";
import { readResult } from "@/lib/readResult";
import { companyAccess, companyAppraisalsView } from "@/lib/overviewCompany";
import { CompanyAppraisalsBlock } from "./CompanyBlocks";

// DW-3i: "Appraisal cycle", the company Overview's Growth block: how far the company's appraisals have come, by stage
// (`GET appraisals`, which for the company-wide tier lists every appraisal of the company, BFF §39). Placed only for the cockpit's
// "full" access, which is the broad tier; a narrower caller would be handed a subset and the block would call it the company.
// Note the reader's argument order: tenant first, then user.
export async function CompanyAppraisals({ me, tenantId }: OverviewWidgetProps) {
  if (!companyAccess(me, tenantId).numbers) return null;
  return <CompanyAppraisalsBlock view={companyAppraisalsView(await readResult(listAppraisals(tenantId, me.userId)))} href="/appraisals" />;
}
