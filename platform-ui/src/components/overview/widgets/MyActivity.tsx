import type { OverviewWidgetProps } from "./index";
import { getProductivity } from "@/lib/pm";
import { todayIso } from "@/lib/overviewNumbers";
import { activityRequestFrom, buildMyActivity } from "@/lib/overviewActivity";
import { fmtDay } from "@/components/pm/activityHeatmap";
import { MyActivityBlock, MY_ACTIVITY_HREF } from "./MyActivityBlock";

// DW-3j: "My activity", the You band's second block: the person's last 16 weeks of PM activity and today so
// far. One read of their own productivity series (`GET /pm/productivity`, self is always allowed), from the
// window's first week on and without `to`, so the server decides what today is. A 404 (the feature is absent)
// is `null` and the block says so; any other failure throws, so the frame's boundary says "Unavailable".
export async function MyActivity({ me, tenantId }: OverviewWidgetProps) {
  const report = await getProductivity(me.userId, tenantId, { userId: me.userId, from: activityRequestFrom(todayIso()) });
  return <MyActivityBlock model={report ? buildMyActivity(report, fmtDay) : null} activityHref={MY_ACTIVITY_HREF} />;
}
