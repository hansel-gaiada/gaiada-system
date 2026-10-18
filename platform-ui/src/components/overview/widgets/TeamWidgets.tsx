import type { OverviewWidgetProps } from "./index";
import { getReportDocument } from "@/lib/reports-data";
import { getCheckinCompliance } from "@/lib/checkins-data";
import { getUnitCompliance } from "@/lib/lms";
import { listAppraisals } from "@/lib/appraisals-data";
import { listProjects } from "@/lib/entities";
import { readProjectPmInputs } from "@/lib/pm";
import { readRequestSummary } from "@/lib/requests-data";
import { readResult } from "@/lib/readResult";
import { reportPeriodKind, todayIso } from "@/lib/overviewNumbers";
import { isOpenProject } from "@/lib/overviewWork";
import {
  blockedReading, blockersView, buildTeamNeedsYou, buildTeamNumbers, ledScopeIsThisUnit, teamAppraisalsView, teamLearningView,
  type BlockersView,
} from "@/lib/overviewTeam";
import { TeamAppraisalsBlock, TeamLearningBlock, TeamNeedsYouBlock, TeamNumbersBlock } from "./TeamBlocks";

// DW-3h: the Team-mode readers of a head's Overview (plan §3.4). The frame draws these only when the person is a head of
// this workspace's unit and chose `?view=team` (`resolveOverviewView`), and every read here is narrowed by the server. Each
// goes through `readResult` or a reader that already returns its three honest kinds, so a refusal or a failure says "No
// access" or "Unavailable" in its block and is never a 0 or a quiet "nothing waiting".

type Props = Pick<OverviewWidgetProps, "me" | "tenantId" | "period" | "deptId" | "workLinks" | "subjectLabel">;

const DEPARTMENT = "the department";

/** Team numbers: the department's report document (the server narrows it to the led unit) and its check-in compliance grid. */
export async function TeamNumbers({ me, tenantId, period, deptId }: Props) {
  if (!deptId) return null;
  const today = todayIso();
  const periodKind = reportPeriodKind(period);
  const [document, compliance] = await Promise.all([
    readResult(getReportDocument(tenantId, me.userId, { grain: "department", scopeRef: deptId, periodKind, start: today, end: today })),
    readResult(getCheckinCompliance(tenantId, me.userId, { unit: deptId, periodKind, start: today })),
  ]);
  const view = buildTeamNumbers({ document, compliance, wider: !ledScopeIsThisUnit(me, deptId, tenantId), selfUserId: me.userId });
  const qs = new URLSearchParams({ unit: deptId, periodKind, start: today, end: today });
  return <TeamNumbersBlock view={view} reportHref={`/reports/team?${qs.toString()}`} />;
}

/** Team needs you: what waits on the department (requests, `GET requests/summary`) and what is blocked in its open projects
 *  (the same honest reads as the Projects block). The person's own queue is Me mode. */
export async function TeamNeedsYou({ me, tenantId, deptId, workLinks, subjectLabel }: Props) {
  if (!deptId) return null;
  const now = new Date();
  const [requests, list] = await Promise.all([
    readRequestSummary(me.userId, tenantId, deptId),
    readResult(listProjects(me.userId, tenantId, undefined, deptId)),
  ]);
  let blockers: BlockersView;
  if (list.kind !== "ok") {
    blockers = { kind: list.kind };
  } else {
    blockers = blockersView(
      await Promise.all(
        list.data.filter(isOpenProject).map(async (p) => ({
          id: p.id,
          name: p.name,
          reading: blockedReading(await readProjectPmInputs(me.userId, tenantId, p.id), now),
        })),
      ),
    );
  }
  const model = buildTeamNeedsYou({ requests, blockers, now });
  return (
    <TeamNeedsYouBlock
      requests={model.requests}
      blockers={model.blockers}
      deptName={subjectLabel ?? DEPARTMENT}
      incomingHref={workLinks?.requestsIncoming ?? null}
      projectsHref={workLinks?.projects ?? null}
    />
  );
}

/** Team learning: `GET lms/compliance?unit=` (BFF §38), which counts only the people placed in the department. */
export async function TeamLearning({ me, tenantId, deptId, subjectLabel }: Props) {
  if (!deptId) return null;
  const view = teamLearningView(await getUnitCompliance(me.userId, tenantId, deptId));
  return <TeamLearningBlock view={view} href={`/learning/compliance?unit=${encodeURIComponent(deptId)}`} deptName={subjectLabel ?? DEPARTMENT} />;
}

/** Team appraisals: `GET appraisals` for a head (BFF §39): the people they lead plus the rows they are the manager of. */
export async function TeamAppraisals({ me, tenantId }: Props) {
  return <TeamAppraisalsBlock view={teamAppraisalsView(await readResult(listAppraisals(tenantId, me.userId)))} href="/appraisals" />;
}
