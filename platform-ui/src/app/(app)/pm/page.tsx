import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getPmScope } from "@/lib/pmScopeActions";
import { resolveScopeWork, pmScopeOptions } from "@/lib/pmScope-data";
import { isDoneStatus, taskUrgency, type UrgencyTier } from "@/lib/pm";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ScopeSwitcher } from "@/components/pm/ScopeSwitcher";
import { OverviewSection, BallSection, TimelineSection, ChartsSection, ProductivitySection } from "@/components/pm/PmScopeSections";
import { isView, BALL_GATE_CAPABILITY } from "./page-helpers";
import "@/components/pm/pm.css";

// The `@all` cross-project PM surface (plan §1.1/§3 workstream A, tickets P4-A3/A4/A5) — Repsona's
// "Cross project" scope, generalised to ALSO serve a single department or a single project through
// the exact same three views (P4-A3's whole point: one scope layer, no fourth set of components).
// `/pm` is the new home for this (decision 1) — `/` stays the personal My Work landing.
//
// One page, tab-switched views (`?view=board|ball|gantt|charts|productivity`, same `?view=` idiom
// `ProjectWorkspaceView` already uses) rather than one route per view: the scope switcher's whole
// point is to stay on the view you're looking at while re-scoping it, and a single page/search-param
// pair makes that trivial (no pathname plumbing needed to know "which view was I on"). `productivity`
// is the exception (see its own note below) — it ignores the scope switcher entirely.
//
// NOT built here (a separate ticket in the same plan): a `Home` column view (P4-A8, needs a
// comments-on-tasks join). Division/grid swimlanes stay on the department board — a division only
// means something inside ONE department, so they don't generalise to `@all`/project scope.
//
// `Productivity` (P4-E3/E4, plan §1.7) IS mounted here as a fourth tab, but it does not consume
// `work`/the scope switcher at all — it is PERSON-grain (whose activity), not project/department/
// tenant-grain like the other three, so re-scoping the board/gantt/charts tabs has no meaning for
// it. It always shows the SIGNED-IN user's own series (self is always allowed server-side; the
// backend's `?userId=` param exists for a future person-switcher, deliberately not built here —
// out of this ticket's scope).
//
// P4-A6: `Responsible`/`Ball` ARE first-class views here, at every scope, with `leadWithUnassigned`
// (./page-helpers) normalising both to lead with a "no user" column, matching the reference
// (§1.4/§1.5). `Responsible` is reached through Overview's "Group by" swimlane selector (no fourth
// set of components, per the ticket). `Ball` used to be the fourth swimlane option there too, but
// owner decision 2026-08-09 pulled it out into its own peer tab — a full board-layout switch just
// to see who's holding the ball cluttered the board view's real job (status triage).
// `page-helpers.ts`'s `PM_SWIMLANES`/`isSwimlane` no longer accept "ball"; it lives only in
// `PmView`/`isView` now.
//
// 2026-08-10 owner directive ("one component set parameterized by scope, not three parallel
// implementations"): the section bodies that used to live below this component (BoardSection/
// BallSection/GanttSection/ChartsSection/ProductivitySection) moved to
// `components/pm/PmScopeSections.tsx` (as OverviewSection/BallSection/TimelineSection/
// ChartsSection/ProductivitySection — "Board"->"Overview" and "Gantt"->"Timeline" per the same
// decision) so `/project-management` (Business's surface) and this page render the identical
// bodies, parameterized only by `basePath` and which `PmScope` they resolved `work` from. A
// department console's Work/Board/Ball/Timeline/Charts tabs stay their own thin pages (they
// already were) — they read a DIFFERENT `dept.tasks`/focus/division shape (lib/departments.ts)
// that doesn't fit `resolveScopeWork`'s `PmScope`, so they call `Board`/`Gantt`/`FacetFilters`
// directly rather than through these sections; see the department board/ball/timeline pages'
// own headers.

type SearchParams = Promise<{
  view?: string; swimlane?: string; tags?: string | string[]; ball?: string | string[]; responsible?: string | string[];
}>;

export default async function PmPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/");

  const scope = await getPmScope();
  const [work, options] = await Promise.all([
    resolveScopeWork(userId, tenant, scope),
    pmScopeOptions(userId, tenant),
  ]);

  const sp = await searchParams;
  const view = isView(sp.view) ? sp.view : "board";
  const canEdit = can(me, "pm.manage", tenant);
  // The Ball tab's OWN gate — deliberately NOT `canEdit` above. `reassignBall` (lib/pmActions.ts)
  // already submits on `pm.contribute` (owner decision 2026-08-06, "anyone can pass the ball");
  // `canEdit` (pm.manage) belongs to Board/Gantt's genuinely manage-gated writes only. See
  // `BALL_GATE_CAPABILITY`'s comment in ./page-helpers for why conflating the two silently undoes
  // the ball decision at the rendering layer even when the write path underneath is correct.
  const canPassBall = can(me, BALL_GATE_CAPABILITY, tenant);

  // P4-G5 precedent: `today` resolved ONCE per render, urgency/isDone derived from THIS task's own
  // project's registry — never recomputed per view, so Board/Gantt/Charts can never disagree.
  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of work.tasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, work.statusesByProject[t.projectId]) }, today);

  const tab = (v: "board" | "ball" | "gantt" | "charts" | "productivity", label: string) => (
    <a href={`/pm?view=${v}`} className={`pm-tab${view === v ? " pm-tab--active" : ""}`} aria-current={view === v ? "page" : undefined}>{label}</a>
  );

  return (
    <>
      <PageHeader
        title={work.label}
        actions={<ScopeSwitcher current={work.scope} departments={options.departments} projects={options.projects} />}
      />
      {work.fellBackToAll && (
        <Card style={{ marginBottom: 16 }}>
          <EmptyNote>The scope you last had selected is no longer available — showing {PM_TERMS.crossProject} instead.</EmptyNote>
        </Card>
      )}

      <div className="pm-tabsrow">
        <div className="pm-tabs">
          {tab("board", PM_TERMS.board)}
          {tab("ball", PM_TERMS.ball)}
          {tab("gantt", PM_TERMS.gantt)}
          {tab("charts", PM_TERMS.charts)}
          {tab("productivity", PM_TERMS.productivity)}
        </div>
      </div>

      {view === "board" && (
        <OverviewSection basePath="/pm" work={work} sp={sp} canEdit={canEdit} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "ball" && (
        <BallSection basePath="/pm" work={work} sp={sp} canPassBall={canPassBall} taskUrgencyById={taskUrgencyById} userId={userId} tenant={tenant} />
      )}
      {view === "gantt" && (
        <TimelineSection basePath="/pm" work={work} canEdit={canEdit} taskUrgencyById={taskUrgencyById} today={today} userId={userId} tenant={tenant} />
      )}
      {view === "charts" && <ChartsSection work={work} userId={userId} tenant={tenant} />}
      {view === "productivity" && <ProductivitySection userId={userId} tenant={tenant} scopeName={me.name} />}
    </>
  );
}
