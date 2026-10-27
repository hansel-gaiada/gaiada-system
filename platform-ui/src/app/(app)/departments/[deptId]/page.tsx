import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment, getDepartmentNode, getServicedCompanies, computeDeptKpis, computeProjectHealth, computeTeamRoster } from "@/lib/departments";
import { listProjects, listMembers } from "@/lib/entities";
import { listPmTasks, listMilestones, listProjectStatuses, projectProgress, type Milestone, type ProjectStatus } from "@/lib/pm";
import { listWorkActivity, objectLabel, activityHref, humanizeVerb, actorLabel } from "@/lib/activity";
import { listClaudeSeats, mySeat, launcherSeatProps } from "@/lib/claudeSeats";
import { toolkitFor } from "@/lib/deptToolkits";
import { activeCompany } from "@/lib/companyContext";
import { getPrefs } from "@/lib/prefs";
import { holdsNoSocialQueue } from "@/lib/socialHome";
import { effectiveSkin, skinsOn } from "@/lib/skins";
import { workspaceFor } from "@/lib/workspaces";
import { functionalConsoleFor } from "@/lib/workspaceAccess";
import { gmAccessFor, canReadGmMoney, isGmDept, parseGmPeriodKind } from "@/lib/gm";
import { companyAccess } from "@/lib/overviewCompany";
import { gmHiddenSections, keepsSection } from "@/lib/overviewCoverage";
import { GmCockpit } from "@/components/departments/gm/GmCockpit";
import { GmAccessDenied } from "@/components/departments/gm/GmAccessDenied";
import { pilotFrame } from "@/components/overview/pilot";
import { Card } from "@/components/ui";
import { Skeleton } from "@/components/Feedback";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ServicedBlock } from "@/components/departments/ServicedBlock";
import { KpiStrip } from "@/components/departments/KpiStrip";
import { HealthRingCard } from "@/components/departments/HealthRingCard";
import { ActivityFeed, type ActivityItem } from "@/components/departments/ActivityFeed";
import { LauncherRow } from "@/components/departments/LauncherRow";
import { TeamRoster } from "@/components/departments/TeamRoster";
import { TeachState } from "@/components/departments/TeachState";
import { SocialHome } from "@/components/social/SocialHome";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ sscope?: string; period?: string }>;

const ACTIVITY_PREVIEW_LIMIT = 8;

// Department console Home — the command center (decision #10). Renders inside
// `.dept-shell__main`; the layout supplies the header and tab strip.
// Real data wiring (P1-07): KPI math + ring health
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

  // The page's own branches (the functional redirect, the GM cockpit, the Overview frame) need only the department's identity, so they
  // read the light org-structure node and the Overview's header and widgets are not held behind `getDepartment` (every tenant PM task
  // plus a status read per project). The Home body that does use `dept.tasks` reads it below, behind its own <Suspense> when framed.
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();

  // DW-7d: HR, Finance and IT are org nodes now, but keep their own consoles. Their department Home is
  // the console root, so the department has one home. Only THIS root page redirects: the sub-pages
  // (`/departments/<id>/projects`, ...) keep working as the functional workspace's PM rows.
  const consoleHref = functionalConsoleFor(dept.name);
  if (consoleHref) redirect(consoleHref);

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
    // Three states, not two (GM-02b): a department lead gets the console NARROWED to the units the
    // server lets them read, rather than the same refusal a member gets.
    const access = gmAccessFor(me, tenant);
    if (access === "none") return <GmAccessDenied />;
    // DW-3z: the cockpit sections the company Overview now shows (§3.8) are left out for the person it shows them to.
    const gmFrame = await pilotFrame(me, tenant, { deptId }, searchParams);
    const hide = gmFrame ? gmHiddenSections(companyAccess(me, tenant)) : [];
    const cockpit = (
      <GmCockpit
        userId={userId}
        tenantId={tenant}
        deptId={deptId}
        periodKind={parseGmPeriodKind(period)}
        anchorDate={new Date().toISOString().slice(0, 10)}
        access={access}
        canReadMoney={canReadGmMoney(me, tenant)}
        hide={hide}
      />
    );
    // DW-3i: the Office of the GM's page is the company Overview, and the cockpit stays under it as "More
    // from the Office of the GM" (plan §2.6 rule 1: nothing is removed), less what its blocks now show (DW-3z, plan §3.8). The
    // refusal above stays frameless, so a person without the access sees no Overview.
    // The cockpit's reads stream behind their own boundary, so the Overview's header and widgets above it do not wait for them.
    return gmFrame ? gmFrame(<Suspense fallback={<HomeBodyFallback label="cockpit" />}>{cockpit}</Suspense>) : cockpit;
  }

  // DW-3a: the Overview frames this Home body, which stays below its bands until the
  // Overview's own blocks replace it. After the GM branch, which frames its own cockpit (DW-3i). The body is built
  // once, as `DepartmentHomeBody`, and passed through `frame`.
  // DW-3z: under the frame, only the sections the Overview does not cover stay (plan §3.8): the Project health, Recent activity
  // and Build tools cards are the Projects block, the Activity tab and Tools & connections now, so their reads are not made.
  const frame = await pilotFrame(me, tenant, { deptId }, searchParams);

  // DW-9d perf: framed, the Home body (the legacy band) is its own async component under <Suspense>, so `pilotFrame`'s Overview header and
  // widgets are sent as soon as they resolve instead of after the body's reads. Unframed, it renders exactly as before.
  const homeBody = <DepartmentHomeBody me={me} userId={userId} tenant={tenant} deptId={deptId} framed={!!frame} searchParams={searchParams} />;

  // SCP-1d (plan §6.1, §6.2): the Social Media workspace's Home is laid out as the team's feed WHEN it is drawn in the Social skin, which is the shell's own answer
  // (`effectiveSkin`, the same inputs the layout gives `buildShellModel`: the workspace's skin, the skins switched on, and the person's choice). A person who chose
  // Standard, and every other department, get exactly the page above. The prefs cookie is read only for the Social Media workspace, so no other Home pays for it.
  const workspace = workspaceFor(activeCompany(me, tenant)?.vertical, dept.name);
  const socialHome = workspace.key === "social-media"
    && effectiveSkin(workspace.skin, skinsOn(process.env.SHELL_SKIN_PREVIEW), (await getPrefs()).skin) === "social";
  // The feed's reads are its own (five, in parallel, each with its own failure state), behind their own boundary so the Overview's header does not wait for them.
  const feed = socialHome
    ? <Suspense fallback={<HomeBodyFallback label="Social Media home" />}><SocialHome userId={userId} tenantId={tenant} deptId={deptId} noQueue={holdsNoSocialQueue(me, tenant)} /></Suspense>
    : null;

  if (frame) {
    const framedBody = <Suspense fallback={<HomeBodyFallback label="department" />}>{homeBody}</Suspense>;
    return feed ? frame(framedBody, feed) : frame(framedBody);
  }
  return feed ? <>{feed}{homeBody}</> : homeBody;
}

/** The quiet loading state of the legacy band under the Overview: two card-shaped blocks, so the band does not jump when it arrives. */
function HomeBodyFallback({ label }: { label: string }) {
  return (
    <div className="fb-skeleton-cards" role="status" aria-busy="true" aria-label={`Loading the ${label} sections`}>
      {[0, 1].map((i) => (
        <div className="fb-skeleton-card" key={i}>
          <Skeleton width={120} height={10} />
          <Skeleton width="70%" height={22} />
          <Skeleton width="100%" height={12} />
        </div>
      ))}
    </div>
  );
}

// The department Home's own body: today's KPI strip, Project health, Recent activity, Build tools, Team and Serviced companies (the ones the
// Overview frame does not cover, plan §3.8). Same reads and same output as when this lived in the page; only the place it runs moved.
async function DepartmentHomeBody({ me, userId, tenant, deptId, framed, searchParams }: {
  me: Awaited<ReturnType<typeof getMe>>; userId: string; tenant: string; deptId: string; framed: boolean; searchParams: SearchParams;
}) {
  const keeps = (section: string) => keepsSection("department-home", section, { framed });

  const { sscope } = await searchParams;
  const servicedScope = sscope ?? "all";
  const [dept, serviced, allProjects, feed, members, mySeats] = await Promise.all([
    // Memoised: the same org read the node above used, plus every tenant PM task and one status read per project.
    getDepartment(userId, tenant, deptId),
    getServicedCompanies(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
    // One over the preview limit: the extra row is never rendered, it only tells the feed whether
    // there is more history behind it, so the card can say "Last 8 shown" instead of implying the
    // department has only ever done eight things. There is no count endpoint to ask instead.
    keeps("recent-activity") ? listWorkActivity(userId, tenant, { deptId, limit: ACTIVITY_PREVIEW_LIMIT + 1 }) : Promise.resolve<Awaited<ReturnType<typeof listWorkActivity>>>([]),
    keeps("recent-activity") ? listMembers(userId, tenant).catch(() => []) : Promise.resolve<Awaited<ReturnType<typeof listMembers>>>([]),
    keeps("build-tools") ? listClaudeSeats(userId, tenant, "me") : Promise.resolve<Awaited<ReturnType<typeof listClaudeSeats>>>({ rows: [], unavailable: false }),
  ]);
  if (!dept) notFound();
  const buildServicedHref = (v: "all" | string) => `/departments/${deptId}${v === "all" ? "" : `?sscope=${v}`}`;

  // WSUX-17: launcher chips with a per-person seat concept ("opens as
  // <seat>" / "Map your seat") reuse the exact `LauncherRow` forward-compat
  // props built for this in P1-02 — only the three Claude tools have a seat
  // (GitHub/Figma/VS Code don't, so they keep their plain `desc`).
  const seat = mySeat(mySeats.rows, userId);
  const seatProps = launcherSeatProps(seat, mySeats.unavailable);
  const CLAUDE_LAUNCHER_KEYS = new Set(["claude-code", "claude", "claude-design"]);
  const { launchers } = toolkitFor(activeCompany(me, tenant)?.vertical, dept.name);
  const launcherItems = launchers.map((l) => ({
    key: l.key, label: l.label, desc: l.desc, href: l.url, glyph: l.glyph, icon: l.icon,
    ...(CLAUDE_LAUNCHER_KEYS.has(l.key) ? seatProps : {}),
  }));
  // Ownership (department_id === deptId, P1-01) is real. Each owned project's
  // ring health comes from ITS OWN task/milestone lists (decision #12), not
  // the department's poly-assignee task list — a project can have open work
  // no one in this department is individually assigned to yet.
  const owned = allProjects.filter((p) => p.department_id === deptId);
  // DW-9d perf: the milestones and the status registry feed ONLY the Project health cards (next milestone, open/at-risk counts, ring
  // composition). Under the Overview frame those cards are not kept (`keeps("project-health")` false: the Projects block shows them), so the
  // two reads per owned project are not made. The KPI strip's Progress is `projectProgress(tasks)` (what `computeProjectHealth(...).progressPct`
  // returns, whatever the milestones or statuses are), so it is the same figure either way. Unframed, every read is made as before.
  const showHealth = keeps("project-health");
  const [ownedTaskLists, ownedMilestoneLists, ownedStatuses] = await Promise.all([
    Promise.all(owned.map((p) => listPmTasks(userId, tenant, p.id))),
    showHealth ? Promise.all(owned.map((p) => listMilestones(userId, tenant, p.id))) : Promise.resolve<Milestone[][]>([]),
    showHealth ? Promise.all(owned.map((p) => listProjectStatuses(userId, tenant, p.id))) : Promise.resolve<ProjectStatus[][]>([]),
  ]);
  // P2-05: health/KPI counts derive from the isDone/isBlocked FLAGS resolved per
  // project's own status registry (correct even when a project renamed "Done").
  const health = showHealth ? owned.map((p, i) => computeProjectHealth(ownedTaskLists[i], ownedMilestoneLists[i], undefined, ownedStatuses[i])) : [];
  const kpis = computeDeptKpis(dept.tasks, ownedTaskLists.map((tasks) => projectProgress(tasks)), undefined, dept.statusesByProject);

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

  const body = (
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

      {keeps("project-health") && <Card title="Project health">
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
      </Card>}

      {keeps("recent-activity") && <Card
        title="Recent activity"
        headerRight={<Link href={`/departments/${deptId}/activity`} className="lux-btn lux-btn--ghost lux-btn--sm">View all →</Link>}
      >
        {/* "Now" is resolved here and handed down so the feed stays pure — see its `nowIso` doc
            for why deciding "Today" inside the component was wrong. */}
        <ActivityFeed items={activityItems} nowIso={new Date().toISOString()} truncated={activityTruncated} />
      </Card>}

      {keeps("build-tools") && <Card title="Build tools">
        <LauncherRow items={launcherItems} />
      </Card>}

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
  return body;
}