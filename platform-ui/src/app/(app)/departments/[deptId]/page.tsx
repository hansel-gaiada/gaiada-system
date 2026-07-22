import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment, getServicedCompanies } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { toolkitFor } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ServicedBlock } from "@/components/departments/ServicedBlock";
import { KpiStrip } from "@/components/departments/KpiStrip";
import { HealthRingCard } from "@/components/departments/HealthRingCard";
import { ActivityFeed } from "@/components/departments/ActivityFeed";
import { LauncherRow } from "@/components/departments/LauncherRow";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ sscope?: string }>;

// Department console Home — the command center (decision #10). Renders inside
// `.dept-shell__main`; the layout supplies the header, tab strip, and the
// persistent My-work rail. This is the STRUCTURE ticket (P1-06): KPI math,
// ring progress, the live activity feed, and rail data are P1-07's job — the
// numeric props below are deliberate placeholders, not a real computation.
//
// Template proof (decision #11): this exact component tree renders for every
// department, bespoke toolkit or not — only the toolkit's launchers and the
// department's own owned-projects/divisions/serviced data differ.
export default async function DepartmentHomePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const { sscope } = await searchParams;
  const servicedScope = sscope ?? "all";
  const [serviced, allProjects] = await Promise.all([
    getServicedCompanies(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
  ]);
  const buildServicedHref = (v: "all" | string) => `/departments/${deptId}${v === "all" ? "" : `?sscope=${v}`}`;

  const { launchers } = toolkitFor(dept.name);
  const launcherItems = launchers.map((l) => ({ key: l.key, label: l.label, desc: l.desc, href: l.url, glyph: l.glyph }));
  // Ownership (department_id === deptId, P1-01) is real — only the ring's
  // health numbers (progress/open/milestone/at-risk) are placeholders; that
  // math is P1-07's job.
  const owned = allProjects.filter((p) => p.department_id === deptId);

  return (
    <>
      <KpiStrip active={0} dueSoon={0} blocked={0} progressPct={0} />

      <Card title="Project health">
        {owned.length === 0 ? (
          <TeachState
            glyph="◎"
            title="No owned projects yet"
            body="Projects with this department as owner will show their health here."
            ctaLabel="View projects"
            ctaHref={`/departments/${deptId}/projects`}
          />
        ) : (
          <div className="dept-ring-grid">
            {owned.map((p) => (
              <HealthRingCard
                key={p.id}
                projectName={p.name}
                href={`/projects/${p.id}`}
                progressPct={0}
                openCount={0}
                nextMilestone={null}
                atRisk={false}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Recent activity"
        headerRight={<Link href={`/departments/${deptId}/activity`} className="lux-btn lux-btn--ghost lux-btn--sm">View all →</Link>}
      >
        <ActivityFeed items={[]} />
      </Card>

      <Card title="Build tools">
        <LauncherRow items={launcherItems} />
      </Card>

      <Card
        title="Team"
        headerRight={<Link href={`/departments/${deptId}/board`} className="lux-btn lux-btn--ghost lux-btn--sm">Open work board →</Link>}
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

      <ServicedBlock envelope={serviced} scope={servicedScope} buildHref={buildServicedHref} />
    </>
  );
}
