// SCP-5f (BFF §63.27.4) — the demo's reads of the cycle steps, on the demo pipeline's cycles, posts and allocations and the monthly report demo. The step maths is
// `demoSocialCycleSteps.ts` (pure); this file only feeds it and shapes the two answers that carry it: the cycle health's `steps` and the Team dashboard's
// `cycle_step_late`. No real client, person or task.
import { todayIsoInDisplayZone } from "./format";
import { demoReportsFor } from "./demoSocialReports";
import { PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, cyclesStore, demoMonthShift, demoWalkBack, type DemoCycle } from "./demoSocialPipeline";
import { demoCycleSteps, type DemoStepRow } from "./demoSocialCycleSteps";

/** The step of the demo that is seeded as closed by hand (BFF §63.27.3): this month's client approval for the first client. */
const HAND_STEP = "client_window";
const firstClientId = (): string | null => PIPE_ENGAGEMENTS[0]?.id ?? null;

/** One demo cycle's steps, or null for a cycle that does not exist. */
export function demoStepsOfCycle(cycleId: string): { cycle: DemoCycle; steps: DemoStepRow[] } | null {
  const cycle = cyclesStore.cycles.find((c) => c.id === cycleId);
  if (!cycle) return null;
  const a = allocStore.byEngagement[cycle.engagementId];
  const today = todayIsoInDisplayZone();
  const reportPeriod = demoMonthShift(cycle.month, -2);
  const reportDelivered = demoReportsFor(reportPeriod).some((r) => r.engagementId === cycle.engagementId && r.status === "delivered");
  const steps = demoCycleSteps({
    cycleId: cycle.id, month: cycle.month, readyBy: cycle.readyBy, today, target: a?.postsPerCycle ?? null, estimates: a?.stepEstimates ?? {},
    reportDueDay: a?.reportDueDay ?? null, reportDelivered, walkBack: demoWalkBack,
    posts: PIPE_POSTS.filter((p) => p.cycleId === cycle.id),
    handSeed: cycle.engagementId === firstClientId() && cycle.month === today.slice(0, 7) ? HAND_STEP : null,
  });
  return { cycle, steps };
}

/** The late open steps of the cycles of `month` (the Team dashboard's `cycle_step_late` rows), oldest due date first. */
export function demoLateSteps(month: string): Array<{ engagementId: string; clientName: string; step: string; title: string; dueDate: string }> {
  const out: Array<{ engagementId: string; clientName: string; step: string; title: string; dueDate: string }> = [];
  for (const cycle of cyclesStore.cycles.filter((c) => c.month === month)) {
    const e = PIPE_ENGAGEMENTS.find((x) => x.id === cycle.engagementId);
    if (!e || e.status === "closed") continue;
    for (const s of demoStepsOfCycle(cycle.id)?.steps ?? []) {
      if (s.late && s.dueDate) out.push({ engagementId: e.id, clientName: e.clientName, step: s.step, title: s.title, dueDate: s.dueDate });
    }
  }
  return out;
}
