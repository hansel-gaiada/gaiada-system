import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment, myDeptTasksToday, myBlockedTasks, toRailPriority } from "@/lib/departments";
import { getPendingApprovals } from "@/lib/data";
import { listAutomationApprovals } from "@/lib/automationApprovals";
import { toolkitFor, tabHref } from "@/lib/deptToolkits";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { MyWorkRail, type RailTaskItem, type RailWaitingItem } from "@/components/departments/MyWorkRail";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Department console shell. Owns the header + tab strip + the PERSISTENT
// My-work rail (decision #10: rendered once here, in `.dept-shell__rail`, so
// every one of the nine tabs sees it without re-rendering it). Each child tab
// page renders only its own body inside `.dept-shell__main`. The set of tabs
// comes from the department's toolkit — Web Dev gets the full nine-tab set;
// departments without a bespoke toolkit get Home only, same shell either way.
//
// Rail data (P1-07, decision #12): "My work today" = this person's own
// not-done department tasks (poly-assignee, `dept.tasks` — already fetched
// by `getDepartment`, no extra call); "Waiting on me" = pending agency
// approvals + pending WS4 automation-approvals + this person's own blocked
// department tasks. Every source degrades to [] on its own (lib/data.ts,
// lib/automationApprovals.ts) so a disabled/missing endpoint never breaks
// the rail — it just renders its empty state. `MyWorkRail` itself does NOT
// sort; the (due, priority) ordering happens here per decision #12.
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

  const [pendingApprovals, automationApprovals] = await Promise.all([
    getPendingApprovals(userId, [{ id: tenant, name: tenant }]),
    listAutomationApprovals(userId, tenant, { status: "pending" }),
  ]);

  const today: RailTaskItem[] = myDeptTasksToday(dept.tasks, userId).map((t) => ({
    id: t.id,
    title: t.title,
    href: `/tasks/${t.id}`,
    dueDate: t.dueDate,
    priority: toRailPriority(t.priority),
    projectName: t.projectName,
  }));

  const waiting: RailWaitingItem[] = [
    ...pendingApprovals.map((a): RailWaitingItem => ({
      id: a.id,
      title: a.subject,
      href: a.campaignId ? `/agency/${a.campaignId}` : "/approvals",
      kind: "approval",
      waitingOn: a.campaign,
    })),
    ...automationApprovals.map((a): RailWaitingItem => ({
      id: a.id,
      title: a.tool_name,
      kind: "approval",
      waitingOn: a.reason ?? (a.origin === "agent" ? (a.agent_name ?? "Agent") : "Automation"),
    })),
    ...myBlockedTasks(dept.tasks, userId).map((t): RailWaitingItem => ({
      id: t.id,
      title: t.title,
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
      <SectionTabs tabs={toolkit.tabs.map((t) => ({ key: t.key, label: t.label, href: tabHref(deptId, t), icon: t.icon }))} />
      <div className="dept-shell">
        <div className="dept-shell__main">{children}</div>
        <div className="dept-shell__rail">
          <MyWorkRail today={today} waiting={waiting} />
        </div>
      </div>
    </>
  );
}
