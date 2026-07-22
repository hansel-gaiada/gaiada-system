import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

type Params = Promise<{ deptId: string }>;

// Department console home — the "who + where it stands" view. The header and tab
// strip are provided by the console layout; this renders the KPIs, the team
// (divisions & people), and a link into the working board. The interactive board
// itself lives on the Projects & Workflow tab.
export default async function DepartmentOverviewPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const done = dept.tasks.filter((t) => t.status === "done").length;
  const open = dept.tasks.length - done;

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Divisions" value={String(dept.divisions.length)} />
        <KpiTile label="People" value={String(dept.people.length)} />
        <KpiTile label="Open tasks" value={String(open)} foot={`${done} done`} />
        <KpiTile label="Total tasks" value={String(dept.tasks.length)} />
      </div>

      <Card
        title="Team"
        headerRight={<Link href={`/departments/${deptId}/workflow`} className="lux-btn lux-btn--ghost lux-btn--sm">Open work board →</Link>}
      >
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
    </>
  );
}
