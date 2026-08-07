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

  const waiting: RailWaitingItem[] = [
    ...waitingFromQueue.map((i): RailWaitingItem => ({
      id: i.id,
      title: i.title,
      href: i.href,
      kind: "approval",
      waitingOn: i.meta,
    })),
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
    </>
  );
}
