import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { RankingsPanel } from "@/components/search/RankingsPanel";
import { listEngagements, listRankSnapshots, getCostProjection, type SearchEngagement } from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ engagementId?: string }>;

// Rankings — SM-14's backend (rank-pull, metrics-pull, rank-snapshots) landed weeks before this UI
// (tracker §6af: "the Rankings console tab is still a PendingCapability placeholder... a Rankings
// UI page remains unclaimed"). DATA-KEY tier: every pull is a metered provider call counted against
// this engagement's budget, unlike the crawl/cluster tabs elsewhere in Optimize. Selection is by
// ENGAGEMENT (mirrors the Keywords tab, not the Audit tab's property picker) because the write side
// (`POST engagements/:id/rank-pull`) is engagement-scoped and 0034 guarantees an engagement has
// exactly one property — the read side then resolves that engagement's `propertyId` itself.
export default async function DepartmentSeoRankingsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const canManage = can(me, "search.manage", tenant);

  const engagements = await listEngagements(userId, tenant);
  const engagementId = sp.engagementId && engagements.some((e) => e.id === sp.engagementId) ? sp.engagementId : engagements[0]?.id;
  const engagement = engagements.find((e) => e.id === engagementId);

  const snapshots = engagement?.propertyId ? await listRankSnapshots(userId, tenant, engagement.propertyId) : [];
  // SM-19 — the same cost-projection SM-29's scope editor already reads, so "Pull ranks now" can
  // disclose its resolved provider/cost/mode/budget-projection before the operator commits (never a
  // second cost formula — PaidActionGate renders exactly this response's "rank" row).
  const projection = engagementId ? await getCostProjection(userId, tenant, engagementId) : null;
  const rankProjection = projection?.perTool.find((t) => t.tool === "rank") ?? null;

  return (
    <Card title="Rankings" headerRight={<CostTierBadge tier="data_key" />}>
      {engagements.length === 0 ? (
        <TeachState
          glyph="⌗"
          title="No engagements yet"
          body="Rank tracking belongs to a client engagement — set one up from the Engagements tab first."
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
              body="Rank tracking needs a property to track positions against — set one on this engagement from the Engagements tab."
              ctaLabel="Go to Engagements"
              ctaHref={`/departments/${deptId}/engagements`}
            />
          ) : (
            <RankingsPanel
              tenantId={tenant} engagementId={engagementId!} snapshots={snapshots} canManage={canManage}
              costProjectionTool={rankProjection} providerMode={projection?.providerMode ?? null}
              overBudget={projection?.overBudget ?? false}
            />
          )}
        </>
      )}
    </Card>
  );
}
