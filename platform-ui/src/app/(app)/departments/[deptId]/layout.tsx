import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment, myDeptTasksToday, myDeptBallTasks, myBlockedTasks, toRailPriority } from "@/lib/departments";
import { titleWithRecurrenceGlyph, isDoneStatus, taskUrgency, openDependencies } from "@/lib/pm";
import { getMyWorkQueue, projectQueueForCompany } from "@/lib/queue";
import { toolkitFor } from "@/lib/deptToolkits";
import { PageHeader } from "@/components/PageHeader";
import { DeptTabs } from "@/components/shell/DeptTabs";
import { DeptShellFrame } from "@/components/departments/DeptShellFrame";
import { MyWorkRail, type RailTaskItem, type RailWaitingItem, type RailBallItem } from "@/components/departments/MyWorkRail";
import { SourceOfferNotice } from "@/components/social/SourceOfferNotice";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Department console shell. Owns the header + the two-level tab nav (DeptTabs:
// primary group strip + a secondary sub-tab strip for the active group) + the
// PERSISTENT My-work rail (decision #10: rendered once here, in
// `.dept-shell__rail`, so every tab sees it without re-rendering it). Each child
// tab page renders only its own body inside `.dept-shell__main`. The groups come
// from the department's toolkit — bespoke departments get the Home · Work ·
// <craft> · Connections spine; departments without a bespoke toolkit get Home
// only, same shell either way.
//
// Rail data (P1-07, decision #12; repointed onto the shared queue per
// WS-UX-plan R-1): "My work today" = this person's own not-done department
// tasks (poly-assignee, `dept.tasks` — already fetched by `getDepartment`, no
// extra call); "Waiting on me" = a dept(=company)-scoped PROJECTION of the
// SAME `getMyWorkQueue` spine the app Home uses (`lib/queue.ts`) — restricted
// to approval/gate items — plus this person's own blocked department tasks
// (which aren't part of the generic queue model; that's dept-board-specific).
// No second merge of approvals/automation-approvals exists here anymore.
// Every source still degrades on its own so a disabled/missing endpoint never
// breaks the rail — it just renders its empty state. `MyWorkRail` itself does
// NOT sort; the (due, priority) ordering happens here per decision #12.
export default async function DepartmentConsoleLayout({ children, params }: { children: React.ReactNode; params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const toolkit = toolkitFor(dept.name);
  const canEditOrg = can(me, "org.edit", tenant);

  const queue = await getMyWorkQueue(me, userId, [{ id: tenant, name: tenant }]);
  const waitingFromQueue = projectQueueForCompany(queue, tenant, { types: ["approval", "gate"] });

  // P4-G5: resolved ONCE for this render, then handed to MyWorkRail via each item's own
  // `urgencyTier` — the rail must never derive it itself (see MyWorkRail.tsx's removed
  // `dueBadge`, which used to compare `dueDate` against a local `new Date()`).
  const railToday = new Date().toISOString().slice(0, 10);
  const today: RailTaskItem[] = myDeptTasksToday(dept.tasks, userId, dept.statusesByProject).map((t) => ({
    id: t.id,
    title: titleWithRecurrenceGlyph(t),
    href: `/tasks/${t.id}`,
    dueDate: t.dueDate,
    priority: toRailPriority(t.priority),
    projectName: t.projectName,
    urgencyTier: taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, dept.statusesByProject[t.projectId]) }, railToday),
  }));

  // P4-K3 — "the ball is with you". Readiness comes from the chain graph (workstream I): a task with
  // an unclosed blocker is yours but not yet startable, and saying so is the difference between a
  // queue and a to-do list. Both urgency and readiness are precomputed HERE — the rail derives
  // neither, same contract as `today` above.
  const ballTaskById = new Map(dept.tasks.map((t) => [t.id, t]));
  const ball: RailBallItem[] = myDeptBallTasks(dept.tasks, userId, dept.statusesByProject).map((t) => ({
    id: t.id,
    title: titleWithRecurrenceGlyph(t),
    href: `/tasks/${t.id}`,
    dueDate: t.dueDate,
    projectName: t.projectName,
    readiness: openDependencies(t, ballTaskById, dept.statusesByProject[t.projectId]).length > 0 ? "blocked" : "ready",
    urgencyTier: taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, dept.statusesByProject[t.projectId]) }, railToday),
  }));

  // How long a thing has been waiting is the ONLY urgency an approval carries — `fromApproval`,
  // `fromAutomation` and `fromGate` all set `urgencyScore: 0`, so `rankByUrgency` leaves this
  // section in whatever order the endpoints answered in. Age is resolved HERE (same rule as
  // `urgencyTier`: the rail never touches a clock) and the list is sorted oldest-first.
  const STALE_AFTER_DAYS = 5;
  // …and at most this many rows carry the mark. The threshold alone is not enough: a queue nobody
  // has touched for a month puts every row past it, and five rust bars mark nothing. Capped, the
  // bar answers "start here" instead of "everything is late", which the ages already say.
  const STALE_MARK_LIMIT = 2;
  const railNowMs = Date.parse(`${railToday}T00:00:00Z`);
  const waitAge = (createdAt?: string | null) => {
    if (!createdAt) return { days: null as number | null };
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) return { days: null as number | null };
    // Floor, not round: something raised 30 hours ago has been waiting "1d", never "2d".
    return { days: Math.max(0, Math.floor((railNowMs - t) / 86_400_000)) };
  };
  const ageLabel = (days: number | null) => (days === null ? undefined : days === 0 ? "today" : `${days}d`);

  const waitingFromQueueRows: RailWaitingItem[] = waitingFromQueue
    .map((i) => ({ item: i, days: waitAge(i.createdAt).days }))
    // Oldest first. `null` (no timestamp) sorts last: an unknown age cannot claim to be the oldest.
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
    .map(({ item, days }, rank): RailWaitingItem => ({
      id: item.id,
      title: item.title,
      href: item.href,
      kind: "approval",
      waitingOn: item.meta,
      age: ageLabel(days),
      // Oldest-first order means `rank` IS the priority, so the cap takes the top rows.
      stale: days !== null && days >= STALE_AFTER_DAYS && rank < STALE_MARK_LIMIT,
    }));

  const waiting: RailWaitingItem[] = [
    ...waitingFromQueueRows,
    // Blocked tasks keep their place after the approvals: they are not waiting on a DECISION from
    // this person, and `pm_tasks` carries no "blocked since" to age them by.
    ...myBlockedTasks(dept.tasks, userId, dept.statusesByProject).map((t): RailWaitingItem => ({
      id: t.id,
      title: titleWithRecurrenceGlyph(t),
      href: `/tasks/${t.id}`,
      kind: "blocked_task",
      waitingOn: t.dependsOn.length > 0 ? "a blocking task" : undefined,
    })),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Department workspace"
        title={dept.name}
        subtitle={toolkit.mission}
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: dept.name }]}
        actions={canEditOrg ? <Link href={`/companies/${tenant}/org`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit structure</Link> : undefined}
      />
      <DeptTabs groups={toolkit.groups} deptId={deptId} />
      <DeptShellFrame groups={toolkit.groups} deptId={deptId} rail={<MyWorkRail today={today} waiting={waiting} ball={ball} />}>
        {children}
      </DeptShellFrame>
      {/* AGPL-3.0 §13 source-offer (docs/plans/smm-tracker.md's "open items" table). Gated on the
          RESOLVED toolkit, not on `deptId` or `dept.name` directly, so it survives whatever id/name
          the org structure assigns — the same robustness `toolkitFor` already gives every other
          consumer of this value. Every other department's pages never call Postiz; only this one
          does, so only this one carries the notice. */}
      {toolkit.slug === "social-media" && <SourceOfferNotice />}
    </>
  );
}
