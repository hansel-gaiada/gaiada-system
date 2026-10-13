import type { OverviewWidgetProps } from "./index";
import { getReportDocument } from "@/lib/reports-data";
import { buildYourNumbers, personReportHref, personReportParams, todayIso } from "@/lib/overviewNumbers";
import { YourNumbersBlock } from "./YourNumbersBlock";

// DW-3d: "Your numbers", the You band's first block: the person's own report for the Overview's period, four
// figures each against the previous period. One read of the person-grain document (`GET /reports/document`), for
// the Overview's company and the signed-in person. A failed read throws, so the frame's boundary says
// "Unavailable": a figure the document did not state is "No data", never a 0 made up here.
export async function YourNumbers({ me, tenantId, period }: OverviewWidgetProps) {
  const today = todayIso();
  const document = await getReportDocument(tenantId, me.userId, personReportParams(me.userId, period, today));
  return <YourNumbersBlock model={buildYourNumbers(document)} reportHref={personReportHref(period, today)} />;
}
