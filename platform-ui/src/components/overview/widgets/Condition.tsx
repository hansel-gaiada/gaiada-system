import type { OverviewWidgetProps } from "./index";
import { getDeptKpis } from "@/lib/deptKpis";
import { conditionAudience, conditionHref, conditionView } from "@/lib/overviewCondition";
import { reportPeriodKind, todayIso } from "@/lib/overviewNumbers";
import { ConditionBlock } from "./ConditionBlock";

// DW-3k: "Department condition", the Department band's first block (plan §5.5, BFF §40): the department's condition from
// `GET dept-kpis?unitNodeId=`, the same honest reader the department KPI page uses (`getDeptKpis` returns a result union and
// never an empty list for a failure).
//   - A head of this workspace's unit sees the banner and a tile per KPI, in Me and in Team mode.
//   - Anyone else the server lets read it (staff placed in the department) sees a quiet strip, with no tiles and no ranking.
//   - A read the server refuses (a visitor from another department) draws nothing: no "No access" box on someone else's department.
//   - A read that failed says "Unavailable", never "on track". With no approved target the answer is "unavailable", said in words.
// The server stays the authority on who may read; the audience only decides how much of the answer is shown.
export async function Condition({ me, tenantId, period, deptId, unitPath, subjectLabel }: OverviewWidgetProps) {
  // HR, Finance, IT and the Company frame have no department unit to read (the frame does not place the block there either).
  if (!deptId) return null;
  const today = todayIso();
  const result = await getDeptKpis(me.userId, tenantId, { unit: deptId, periodKind: reportPeriodKind(period), start: today });
  const view = conditionView(conditionAudience(me, tenantId, { deptId, unitPath }), result, conditionHref(deptId, period, today));
  if (view.kind === "none") return null;
  return <ConditionBlock view={view} subjectLabel={subjectLabel} />;
}
