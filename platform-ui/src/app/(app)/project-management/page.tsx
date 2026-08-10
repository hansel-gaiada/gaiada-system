import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { PM_SCOPE_ALL } from "@/lib/pmScope";
import { resolveScopeWork } from "@/lib/pmScope-data";
import { isDoneStatus, taskUrgency, type UrgencyTier } from "@/lib/pm";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { PageHeader } from "@/components/PageHeader";
import { OverviewSection, BallSection, TimelineSection, ChartsSection, ProductivitySection } from "@/components/pm/PmScopeSections";
import { PmSurfaceTabs } from "@/components/pm/PmSurfaceTabs";
import { BALL_GATE_CAPABILITY } from "@/app/(app)/pm/page-helpers";
import "@/components/pm/pm.css";

// Business's Project Management surface (owner directive 2026-08-10: "Business and Departments
// must use the same interface as /pm... one component set parameterized by scope, not three
// parallel implementations"). This IS that reuse — `OverviewSection`/`BallSection`/
// `TimelineSection`/`ChartsSection`/`ProductivitySection` (components/pm/PmScopeSections.tsx) are
// the EXACT same components `/pm` mounts, just resolved from a scope that never changes: `PM_SCOPE_ALL`
// ("what's on the books" — the whole business, no per-department/per-project drill-down; that's what
// `/pm`'s own scope switcher and each department console are for). There is no `ScopeSwitcher` here
// on purpose — Business's lens IS "everything", not a choice.
//
// Sidebar (owner ask #7): this single row replaces what used to be two separate Business nav rows
// ("Projects", "Tasks"). Those routes are UNCHANGED (`/projects`, `/tasks` keep their own rich list
// pages — the hard constraint against breaking bookmarked deep links) — they are folded in as two
// more tabs on `PmSurfaceTabs`, which every one of these three pages now shares, so navigating
// Overview -> Projects -> Tasks -> back to Ball reads as one continuous surface instead of jumping
// across unrelated parts of the sidebar. See `PmSurfaceTabs`'s own header for why Projects/Tasks are
// plain links rather than a `?view=` value like the other five.
type SearchParams = Promise<{
  view?: string; swimlane?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[];
}>;

type View = "board" | "ball" | "gantt" | "charts" | "productivity";
function isView(v: string | undefined): v is View {
  return v === "board" || v === "ball" || v === "gantt" || v === "charts" || v === "productivity";
}

export default async function ProjectManagementPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/");

  // Fixed at `@all` — see the header note. No `getPmScope()`/cookie read here on purpose: this
  // page's whole point is to always show the whole business, regardless of whatever project or
  // department the user last had `/pm` scoped to.
  const work = await resolveScopeWork(userId, tenant, PM_SCOPE_ALL);

  const sp = await searchParams;
  const view = isView(sp.view) ? sp.view : "board";
  const canEdit = can(me, "pm.manage", tenant);
  const canPassBall = can(me, BALL_GATE_CAPABILITY, tenant);

  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of work.tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, work.statusesByProject[t.projectId]) }, today);

  return (
    <>
      <PageHeader eyebrow="Business" title={PM_TERMS.projectManagement} />
      <PmSurfaceTabs active={view} />

      {view === "board" && (
        <OverviewSection basePath="/project-management" work={work} sp={sp} canEdit={canEdit} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "ball" && (
        <BallSection basePath="/project-management" work={work} sp={sp} canPassBall={canPassBall} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "gantt" && (
        <TimelineSection basePath="/project-management" work={work} canEdit={canEdit} taskUrgencyById={taskUrgencyById} today={today} userId={userId} tenant={tenant} />
      )}
      {view === "charts" && <ChartsSection work={work} userId={userId} tenant={tenant} />}
      {view === "productivity" && <ProductivitySection userId={userId} tenant={tenant} scopeName={me.name} />}
    </>
  );
}
