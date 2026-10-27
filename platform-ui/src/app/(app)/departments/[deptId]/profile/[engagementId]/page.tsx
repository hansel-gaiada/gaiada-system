import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { departmentForWorkspace } from "@/lib/workspaceAccess";
import { readOrgRoot } from "@/lib/campaigns-data";
import { can } from "@/lib/rbac";
import { DISPLAY_TZ, todayIsoInDisplayZone } from "@/lib/format";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getClientBrandBook, getClientCalendar, getCycleView, getEngagementProjectId, getFeedPreview } from "@/lib/socialClient-data";
import { gridRange, parseClientTab, parseMonth, type ClientPost } from "@/lib/socialClient";
import { getClientAccounts } from "@/lib/socialSimulatedAccounts-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { BrandBookForm } from "@/components/social/BrandBookForm";
import { ClientHeader } from "@/components/social/ClientHeader";
import { ClientAccounts, type ClientAccountsRead } from "@/components/social/ClientAccounts";
import { ClientTabs } from "@/components/social/ClientTabs";
import { ClientPlan } from "@/components/social/ClientPlan";
import { ClientStories } from "@/components/social/ClientStories";
import { ClientCalendar } from "@/components/social/ClientCalendar";
import { FeedPreview } from "@/components/social/FeedPreview";
import { ClientPostList } from "@/components/social/ClientPostList";
import { ClientCreate } from "@/components/social/ClientCreate";
import "@/components/social/cycles.css";
import "@/components/social/allocation.css";
import "@/components/social/client.css";

type Params = Promise<{ deptId: string; engagementId: string }>;
type SearchParams = Promise<{ tab?: string | string[]; month?: string | string[]; new?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

/** The day an instant falls on, and its time of day, in the zone every date on screen is shown in. */
const dayOf = (iso: string): string => todayIsoInDisplayZone(new Date(iso));
const timeOf = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: DISPLAY_TZ }).format(new Date(iso));

// SCP-1k, SCP-1m, SCP-3d (BFF §63.4, §63.5, §63.10, §63.17; plan §8 rows 1k, 1m and 3d): one client's page, on tabs by `?tab=`: Plan, Stories, Calendar, Feed preview, List
// and the Client profile (the brand book). The Feed preview is the client's grid with drag-to-swap of publish dates (`GET engagements/:id/feed-preview`); it needs no
// cycle, because it shows every dated post of the client. The header is the profile: the count against the target (stories and extra posts beside it), the cycle
// line, the tone and the highlights. Every read is a `ReadResult`: a refusal or a failure is said in words, never drawn as an empty grid.
//
// Reads: the client's row from `GET allocation` (readable by the whole team); `GET cycles/:cycleId/health` for the cycle's posts (Plan, Stories, List and the
// header); `GET calendar` for the Calendar tab only; the brand book for the header's tone and the Client profile tab. A post opens the post page (SCP-1e).
// Writes live in the client components: the create bar (SCP-1m) and the List's bulk actions. The server decides each one; the page hides nothing by role.
export default async function SocialClientPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, engagementId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  const company = activeCompany(me, tenant);
  // The client page belongs to the Social Media workspace only.
  if (workspaceFor(company?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const tab = parseClientTab(sp.tab);
  const newMode = first(sp.new) === "extra" ? "extra" : first(sp.new) === "post" ? "post" : null;

  const allocation = await getAllocation(userId, tenant);
  if (allocation.kind === "forbidden") {
    return <ReadRefusal subject="this client" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (allocation.kind === "unavailable") return <ReadRefusal subject="This client" kind="unavailable" reason={allocation.reason} />;
  const row = allocation.data.find((r) => r.engagementId === engagementId);
  if (!row) {
    return (
      <Card title="No such client">
        <p className="scp-note">This client is not in the Social Media allocation: it may be closed, or the link is out of date.</p>
      </Card>
    );
  }

  const today = todayIsoInDisplayZone();
  const month = parseMonth(sp.month, today.slice(0, 7));
  const cycleId = row.thisCycle?.cycleId ?? null;
  const [cycle, brand, project, root, accountsRead] = await Promise.all([
    cycleId ? getCycleView(userId, tenant, cycleId) : Promise.resolve(null),
    getClientBrandBook(userId, tenant, row.clientId),
    getEngagementProjectId(userId, tenant, engagementId),
    readOrgRoot(me, tenant),
    getClientAccounts(userId, tenant, row.clientId),
  ]);
  const calendar = tab === "calendar" ? await getClientCalendar(userId, tenant, { ...gridRange(month), engagementId }) : null;
  const feed = tab === "preview" ? await getFeedPreview(userId, tenant, engagementId) : null;

  const cycleView = cycle?.kind === "ok" ? cycle.data : null;
  const posts: ClientPost[] = cycleView?.posts ?? [];
  const tone = brand.kind === "ok" ? (brand.data?.toneSummary || null) : undefined;
  // SCP-Sb: the client's accounts, each simulated one marked; the seed button for the four approvers.
  const accounts: ClientAccountsRead = accountsRead.kind === "ok" ? { kind: "ok", accounts: accountsRead.data } : accountsRead.kind === "forbidden" ? { kind: "forbidden" } : { kind: "unavailable" };
  const askCreatives = departmentForWorkspace(root, company?.vertical, "creatives") !== null;

  return (
    <div className="scp-client">
      <ClientHeader row={row} cycle={cycleView} cycleUnavailable={cycle !== null && cycle.kind !== "ok"} tone={tone} />
      <ClientAccounts engagementId={engagementId} read={accounts} canPlan={row.canPlan} />
      <ClientCreate
        key={newMode ?? "closed"}
        deptId={deptId} cycleId={cycleId} platforms={row.platforms} pillars={brand.kind === "ok" ? brand.data?.contentPillars ?? [] : []}
        projectId={project.kind === "ok" ? project.data : null} askCreatives={askCreatives} openInitial={newMode}
      />
      <ClientTabs deptId={deptId} engagementId={engagementId} active={tab} />

      {tab === "brand" ? (
        <BrandBookForm
          key={row.clientId} clientId={row.clientId} clientName={row.clientName} canEdit={can(me, "social.scope.write", tenant)}
          initial={brand.kind === "ok" && brand.data ? brand.data : undefined}
        />
      ) : tab === "calendar" ? (
        calendar?.kind === "ok" ? (
          <ClientCalendar deptId={deptId} engagementId={engagementId} month={month} items={calendar.data} today={today} dayOf={dayOf} timeOf={timeOf} />
        ) : calendar?.kind === "forbidden" ? (
          <ReadRefusal subject="this client's calendar" kind="forbidden" inline />
        ) : (
          <ReadRefusal subject="This client's calendar" kind="unavailable" reason={calendar?.kind === "unavailable" ? calendar.reason : undefined} inline />
        )
      ) : tab === "preview" ? (
        feed?.kind === "ok" ? (
          <FeedPreview deptId={deptId} engagementId={engagementId} items={feed.data.items} liveHidden={feed.data.liveHidden} />
        ) : feed?.kind === "forbidden" ? (
          <ReadRefusal subject="this client's feed preview" kind="forbidden" inline />
        ) : (
          <ReadRefusal subject="This client's feed preview" kind="unavailable" reason={feed?.kind === "unavailable" ? feed.reason : undefined} inline />
        )
      ) : !cycleId ? (
        <p className="scp-note">This client has no cycle this month, so there are no posts to show. A Social Media head opens the cycle by setting its deadline in Settings.</p>
      ) : cycle?.kind === "forbidden" ? (
        <ReadRefusal subject="this cycle's posts" kind="forbidden" inline />
      ) : cycle?.kind === "unavailable" ? (
        <ReadRefusal subject="This cycle's posts" kind="unavailable" reason={cycle.reason} inline />
      ) : tab === "plan" ? (
        <ClientPlan deptId={deptId} engagementId={engagementId} posts={posts} target={row.postsPerCycle} canAdd />
      ) : tab === "stories" ? (
        <ClientStories deptId={deptId} posts={posts} />
      ) : (
        <ClientPostList deptId={deptId} posts={posts} />
      )}
    </div>
  );
}
