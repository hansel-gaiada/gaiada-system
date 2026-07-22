import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, tabHref } from "@/lib/deptToolkits";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { MyWorkRail } from "@/components/departments/MyWorkRail";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Department console shell. Owns the header + tab strip + the PERSISTENT
// My-work rail (decision #10: rendered once here, in `.dept-shell__rail`, so
// every one of the nine tabs sees it without re-rendering it). Each child tab
// page renders only its own body inside `.dept-shell__main`. The set of tabs
// comes from the department's toolkit — Web Dev gets the full nine-tab set;
// departments without a bespoke toolkit get Home only, same shell either way.
//
// Rail props are placeholder/empty here (P1-06, structure only) — the real
// "my work today" / "waiting on me" queries + sort are P1-07's job.
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
          <MyWorkRail today={[]} waiting={[]} />
        </div>
      </div>
    </>
  );
}
