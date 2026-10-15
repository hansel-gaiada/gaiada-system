import type { OverviewWidgetProps } from "./index";
import { getActivitySeries } from "@/lib/activitySeries";
import { buildMyActivity } from "@/lib/overviewActivity";
import { fmtDay } from "@/components/pm/activityHeatmap";
import { MyActivityBlock, MY_ACTIVITY_HREF } from "./MyActivityBlock";

// DW-3j, DW-4h-3: "My activity", the You band's second block: the person's last 16 weeks of ALL their work, by kind, and
// today so far. One read of their own all-work series (`GET /activity/series`, BFF section 44.3; self is always allowed),
// with neither `from` nor `to`: the server answers its default year ending on its own today in its own time zone, and
// that `to` is where the window ends (never a UTC "today" of this machine). A refusal (403) draws "nothing is shown"; any
// other failure (a 404 included: an older backend without section 44 is not "you did nothing") throws, so the frame's
// boundary says "Unavailable".
export async function MyActivity({ me, tenantId }: OverviewWidgetProps) {
  const res = await getActivitySeries(me.userId, tenantId, { subjectUserId: me.userId });
  if (res.kind === "error") throw new Error(res.reason);
  return <MyActivityBlock model={res.kind === "ok" ? buildMyActivity(res.data, fmtDay) : null} activityHref={MY_ACTIVITY_HREF} />;
}
