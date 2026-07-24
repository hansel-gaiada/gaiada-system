import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment, getServicedCompanies, computeDeptKpis, computeProjectHealth } from "@/lib/departments";
import { listProjects, listMembers } from "@/lib/entities";
import { listPmTasks, listMilestones, listProjectStatuses } from "@/lib/pm";
import { listWorkActivity, objectLabel, activityHref, humanizeVerb, actorLabel } from "@/lib/activity";
import { listClaudeSeats, mySeat, launcherSeatProps } from "@/lib/claudeSeats";
import { toolkitFor } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ServicedBlock } from "@/components/departments/ServicedBlock";
import { KpiStrip } from "@/components/departments/KpiStrip";
import { HealthRingCard } from "@/components/departments/HealthRingCard";
import { ActivityFeed, type ActivityItem } from "@/components/departments/ActivityFeed";
import { LauncherRow } from "@/components/departments/LauncherRow";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ sscope?: string }>;

const ACTIVITY_PREVIEW_LIMIT = 8;

// Department console Home — the command center (decision #10). Renders inside
// `.dept-shell__main`; the layout supplies the header, tab strip, and the
// persistent My-work rail. Real data wiring (P1-07): KPI math + ring health
// come from each owned project's own PM tasks/milestones (lib/pm.ts); the
// feed is the F2 work-activity read (lib/activity.ts) scoped to this
// department. Every reader degrades to [] on its own so a missing/disabled
// endpoint renders the same TeachState empty-states P1-06 already wired.
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
  const [serviced, allProjects, feed, members, mySeats] = await Promise.all([
    getServicedCompanies(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
    listWorkActivity(userId, tenant, { deptId, limit: ACTIVITY_PREVIEW_LIMIT }),
    listMembers(userId, tenant).catch(() => []),
    listClaudeSeats(userId, tenant, "me"),
  ]);
  const buildServicedHref = (v: "all" | string) => `/departments/${deptId}${v === "all" ? "" : `?sscope=${v}`}`;

  // WSUX-17: launcher chips with a per-person seat concept ("opens as
  // <seat>" / "Map your seat") reuse the exact `LauncherRow` forward-compat
  // props built for this in P1-02 — only the three Claude tools have a seat
  // (GitHub/Figma/VS Code don't, so they keep their plain `desc`).
  const seat = mySeat(mySeats.rows, userId);
  const seatProps = launcherSeatProps(seat, mySeats.unavailable);
  const CLAUDE_LAUNCHER_KEYS = new Set(["claude-code", "claude", "claude-design"]);
  const { launchers } = toolkitFor(dept.name);
  const launcherItems = launchers.map((l) => ({
    key: l.key, label: l.label, desc: l.desc, href: l.url, glyph: l.glyph,
    ...(CLAUDE_LAUNCHER_KEYS.has(l.key) ? seatProps : {}),
  }));
  // Ownership (department_id === deptId, P1-01) is real. Each owned project's
  // ring health comes from ITS OWN task/milestone lists (decision #12), not
  // the department's poly-assignee task list — a project can have open work
  // no one in this department is individually assigned to yet.
  const owned = allProjects.filter((p) => p.department_id === deptId);
  const [ownedTaskLists, ownedMilestoneLists, ownedStatuses] = await Promise.all([
    Promise.all(owned.map((p) => listPmTasks(userId, tenant, p.id))),
    Promise.all(owned.map((p) => listMilestones(userId, tenant, p.id))),
    Promise.all(owned.map((p) => listProjectStatuses(userId, tenant, p.id))),
  ]);
  // P2-05: health/KPI counts derive from the isDone/isBlocked FLAGS resolved per
  // project's own status registry (correct even when a project renamed "Done").
  const health = owned.map((p, i) => computeProjectHealth(ownedTaskLists[i], ownedMilestoneLists[i], undefined, ownedStatuses[i]));
  const kpis = computeDeptKpis(dept.tasks, health.map((h) => h.progressPct), undefined, dept.statusesByProject);

  const nameById = new Map(members.map((mm) => [mm.user_id, mm.name]));
  const activityItems: ActivityItem[] = feed.map((row) => ({
    id: row.id,
    actor: actorLabel(row, Object.fromEntries(nameById)),
    verb: humanizeVerb(row.verb),
    objectLabel: objectLabel(row),
    href: activityHref(row),
    occurredAt: row.occurredAt,
    source: row.source,
  }));

  return (
    <>
      <KpiStrip
        active={kpis.active}
        dueSoon={kpis.dueSoon}
        blocked={kpis.blocked}
        progressPct={kpis.progressPct}
        totalTasksFoot={dept.tasks.length ? `of ${dept.tasks.length} total` : undefined}
        totalProjectsFoot={owned.length ? `across ${owned.length} project${owned.length === 1 ? "" : "s"}` : undefined}
      />

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
            {owned.map((p, i) => (
              <HealthRingCard
                key={p.id}
                projectName={p.name}
                href={`/departments/${deptId}/projects/${p.id}`}
                progressPct={health[i].progressPct}
                openCount={health[i].openCount}
                nextMilestone={health[i].nextMilestone}
                atRisk={health[i].atRisk}
                atRiskReason={health[i].atRiskReason}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Recent activity"
        headerRight={<Link href={`/departments/${deptId}/activity`} className="lux-btn lux-btn--ghost lux-btn--sm">View all →</Link>}
      >
        <ActivityFeed items={activityItems} />
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
