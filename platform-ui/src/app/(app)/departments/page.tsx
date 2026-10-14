import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { departmentOverviewHref } from "@/lib/workspaces";
import { listDepartments } from "@/lib/departments";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

export default async function DepartmentsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Company" title="Departments" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const depts = await listDepartments(userId, tenant);
  const activeCompany = me.companies.find((c) => c.id === tenant);

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title="Departments"
        subtitle={`Each department's workspace — its people, divisions and live work${activeCompany ? ` in ${activeCompany.name}` : ""}.`}
        actions={can(me, "org.edit", tenant) ? <Link href={`/companies/${tenant}/org`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit structure</Link> : undefined}
      />
      {depts.length === 0 ? (
        <EmptyNote>No departments yet. Add them in the org structure editor.</EmptyNote>
      ) : (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {depts.map((d) => (
            // DW-8e: each card opens that department's workspace Overview (HR, Finance and IT their own consoles).
            // No "Head" line: the org tree marks no lead and the positions read names no holder, and a head is never guessed.
            <Link key={d.id} href={departmentOverviewHref(activeCompany?.vertical, d, tenant)}
              style={{ display: "block", border: "0.5px solid var(--erp-hairline)", background: "var(--surface-card)", padding: 18, textDecoration: "none", borderLeft: "2px solid var(--erp-accent)" }}>
              <div style={{ font: "400 17px var(--font-display)", color: "var(--text-primary)", marginBottom: 12 }}>{d.name}</div>
              <div style={{ display: "flex", gap: 18 }}>
                {[["Divisions", d.divisions], ["People", d.people], ["Open tasks", d.openTasks]].map(([l, n]) => (
                  <div key={l as string} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ font: "700 18px var(--font-display)", color: "var(--text-primary)" }}>{n as number}</span>
                    <span style={{ font: "600 11px var(--font-body)", color: "var(--ink-subtle)" }}>{l as string}</span>
                  </div>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
