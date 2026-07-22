import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { moveTask } from "@/lib/pmActions";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";

type Params = Promise<{ deptId: string }>;

export default async function DepartmentWorkspacePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const done = dept.tasks.filter((t) => t.status === "done").length;
  const canEditOrg = can(me, "org.edit", tenant);

  return (
    <>
      <PageHeader
        eyebrow="Department"
        title={dept.name}
        subtitle="The department's team and its live work in one place."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: dept.name }]}
        actions={canEditOrg ? <Link href={`/companies/${tenant}/org`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit structure</Link> : undefined}
      />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Divisions" value={String(dept.divisions.length)} />
        <KpiTile label="People" value={String(dept.people.length)} />
        <KpiTile label="Tasks" value={String(dept.tasks.length)} foot={`${done} done`} />
        <KpiTile label="Open" value={String(dept.tasks.length - done)} />
      </div>

      <div style={{ marginBottom: 12, font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>Work board</div>
      {dept.tasks.length === 0 ? (
        <Card><EmptyNote>No work routed to this department yet. Tasks assigned to {dept.name}, its divisions, or its people appear here.</EmptyNote></Card>
      ) : (
        <Board columns={dept.columns} move={moveTask} />
      )}

      <div style={{ marginTop: 24 }}>
        <Card title="Divisions & people">
          {dept.divisions.length === 0 && dept.people.length === 0 ? (
            <EmptyNote>No divisions or people placed yet — add them in the org structure editor.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              {dept.divisions.map((v) => (
                <div key={v.id} style={{ border: "0.5px solid var(--erp-hairline)", padding: 14 }}>
                  <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-60)", borderLeft: "2px solid var(--erp-hairline)", paddingLeft: 8, marginBottom: 10 }}>{v.name}</div>
                  {v.people.length === 0 ? (
                    <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>No one placed yet.</span>
                  ) : v.people.map((p) => (
                    <Link key={p.id} href={`/people/${p.id}`} style={{ display: "block", font: "400 13px var(--font-body)", color: "var(--text-primary)", textDecoration: "none", padding: "3px 0" }}>{p.name}</Link>
                  ))}
                </div>
              ))}
              {dept.divisions.length === 0 && dept.people.map((p) => (
                <Link key={p.id} href={`/people/${p.id}`} style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)", textDecoration: "none" }}>{p.name}</Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
