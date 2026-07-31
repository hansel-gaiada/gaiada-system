import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { GscGa4Panel } from "@/components/search/GscGa4Panel";
import {
  listEngagements, listGscPerformance, listTopGscQueries, listGa4Metrics,
  type SearchEngagement,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ engagementId?: string }>;

// Search Console & GA4 — SM-25b's read-ingestion surface, wired here for the first time (the six
// routes it landed had "no surface at all" before this ticket). $0 to the shared vendor deposit
// (§A12.1: a third egress class, client-private OAuth) — CostTierBadge renders "free" for that
// reason, even though the numbers are real client data. Selection is by ENGAGEMENT, matching the
// Rankings tab, because the WRITE side (gsc-pull/ga4-pull) is engagement-scoped and 0034 guarantees
// exactly one property per engagement.
export default async function DepartmentSeoGscGa4Page({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasTab = deptTabs(toolkitFor(dept.name)).some((t) => t.path === "gsc-ga4");
  if (!hasTab) {
    return (
      <Card title="Search Console & GA4">
        <EmptyNote>This tab isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  const sp = await searchParams;
  const canManage = can(me, "search.manage", tenant);

  const engagements = await listEngagements(userId, tenant);
  const engagementId = sp.engagementId && engagements.some((e) => e.id === sp.engagementId) ? sp.engagementId : engagements[0]?.id;
  const engagement = engagements.find((e) => e.id === engagementId);

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 28 * 86400_000).toISOString().slice(0, 10);

  const [gscRows, topQueries, ga4Rows] = engagement?.propertyId
    ? await Promise.all([
        listGscPerformance(userId, tenant, engagement.propertyId, { startDate, endDate, limit: 500 }),
        listTopGscQueries(userId, tenant, engagement.propertyId, { startDate, endDate, limit: 25 }),
        listGa4Metrics(userId, tenant, engagement.propertyId, { startDate, endDate, limit: 500 }),
      ])
    : [[], [], []];

  return (
    <Card title="Search Console & GA4" headerRight={<CostTierBadge tier="free" />}>
      {engagements.length === 0 ? (
        <TeachState
          glyph="⌗"
          title="No engagements yet"
          body="Search Console and GA4 data belong to a client engagement — set one up from the Engagements tab first."
          ctaLabel="Go to Engagements"
          ctaHref={`/departments/${deptId}/engagements`}
        />
      ) : (
        <>
          <form className="lux-filters" method="get" aria-label="Engagement filter" style={{ marginBottom: 16 }}>
            <label className="lux-filters__field">
              <span>Engagement</span>
              <select name="engagementId" defaultValue={engagementId}>
                {engagements.map((e: SearchEngagement) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">View</button>
            </div>
          </form>

          {!engagement?.propertyId ? (
            <TeachState
              glyph="⚑"
              title="No property on this engagement"
              body="Set a property on this engagement from the Engagements tab first."
              ctaLabel="Go to Engagements"
              ctaHref={`/departments/${deptId}/engagements`}
            />
          ) : (
            <>
              <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", marginBottom: 12 }}>
                Client-private Google OAuth — never the shared market-data deposit. Link an account from
                the <a href={`/departments/${deptId}/connections`} style={{ color: "var(--text-primary)" }}>Connections tab</a> first if nothing pulls.
              </p>
              <GscGa4Panel
                tenantId={tenant} engagementId={engagementId!}
                gscRows={gscRows} topQueries={topQueries} ga4Rows={ga4Rows} canManage={canManage}
              />
            </>
          )}
        </>
      )}
    </Card>
  );
}
