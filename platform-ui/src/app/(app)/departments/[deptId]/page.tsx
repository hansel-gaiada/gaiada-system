import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment, getServicedCompanies, computeDeptKpis, computeProjectHealth, computeTeamRoster } from "@/lib/departments";
import { listProjects, listMembers } from "@/lib/entities";
import { listPmTasks, listMilestones, listProjectStatuses } from "@/lib/pm";
import { listWorkActivity, objectLabel, activityHref, humanizeVerb, actorLabel } from "@/lib/activity";
import { listClaudeSeats, mySeat, launcherSeatProps } from "@/lib/claudeSeats";
import { toolkitFor } from "@/lib/deptToolkits";
import { canReadGmConsole, isGmDept, parseGmPeriodKind } from "@/lib/gm";
import { GmCockpit } from "@/components/departments/gm/GmCockpit";
import { GmAccessDenied } from "@/components/departments/gm/GmAccessDenied";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ServicedBlock } from "@/components/departments/ServicedBlock";
import { KpiStrip } from "@/components/departments/KpiStrip";
import { HealthRingCard } from "@/components/departments/HealthRingCard";
import { ActivityFeed, type ActivityItem } from "@/components/departments/ActivityFeed";
import { LauncherRow } from "@/components/departments/LauncherRow";
import { TeamRoster } from "@/components/departments/TeamRoster";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ sscope?: string; period?: string }>;

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

  // ── GM: the cockpit replaces the template Home (GM-03) ──────────────────────────────────────────
  // Branched HERE, before the template's own reads, because none of them answer the GM's question.
  // The template Home assembles THIS department's owned projects; the cockpit asks
  // `reports/overview` at company + department grain. Running both would mean five wasted PM fetches
  // per render for a department whose people own oversight projects, not delivery.
  //
  // This is also the only department Home that needs a gate — it shows the whole business, and
  // `Departments` sidebar rows are ungated by design. See `lib/gm.ts` for why the capability is
  // `reports.company.view` and why a refusal renders a page rather than a 404.
  if (isGmDept(dept.name)) {
    const { period } = await searchParams;
    if (!canReadGmConsole(me, tenant)) return <GmAccessDenied />;
    return (
      <GmCockpit
        userId={userId}
        tenantId={tenant}
        deptId={deptId}
        periodKind={parseGmPeriodKind(period)}
        anchorDate={new Date().toISOString().slice(0, 10)}
      />
    );
  }

  const { sscope } = await searchParams;
  const servicedScope = sscope ?? "all";
  const [serviced, allProjects, feed, members, mySeats] = await Promise.all([
    getServicedCompanies(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
    // One over the preview limit: the extra row is never rendered, it only tells the feed whether
    // there is more history behind it, so the card can say "Last 8 shown" instead of implying the
    // department has only ever done eight things. There is no count endpoint to ask instead.
    listWorkActivity(userId, tenant, { deptId, limit: ACTIVITY_PREVIEW_LIMIT + 1 }),
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
    key: l.key, label: l.label, desc: l.desc, href: l.url, glyph: l.glyph, icon: l.icon,
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
  const activityTruncated = feed.length > ACTIVITY_PREVIEW_LIMIT;
  const activityItems: ActivityItem[] = feed.slice(0, ACTIVITY_PREVIEW_LIMIT).map((row) => ({
    id: row.id,
    actor: actorLabel(row, Object.fromEntries(nameById)),
    // No platform person behind it. `actorLabel` falls back to `actorExternal`, so "scheduler"
    // arrives looking like a colleague unless the caller says otherwise.
    automated: !row.actorUserId,
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
        blockedProjects={kpis.blockedProjects}
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
                composition={health[i].composition}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Recent activity"
        headerRight={<Link href={`/departments/${deptId}/activity`} className="lux-btn lux-btn--ghost lux-btn--sm">View all →</Link>}
      >
        {/* "Now" is resolved here and handed down so the feed stays pure — see its `nowIso` doc
            for why deciding "Today" inside the component was wrong. */}
        <ActivityFeed items={activityItems} nowIso={new Date().toISOString()} truncated={activityTruncated} />
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
          /* `computeTeamRoster` owns the bucketing, including the "No division" group — the block
             this replaced rendered unbucketed people ONLY when the department had no divisions, so
             one division was enough to make them vanish from the card. */
          <TeamRoster
            groups={computeTeamRoster(dept.divisions, dept.people, dept.tasks, dept.statusesByProject)}
            personHref={(id) => `/people/${id}`}
          />
        )}
      </Card>

      <ServicedBlock envelope={serviced} scope={servicedScope} buildHref={buildServicedHref} />
    </>
  );
}
