import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { AccessDenied } from "@/components/social/AccessDenied";
import { AnalyticsPanel } from "@/components/social/AnalyticsPanel";
import { UsagePanel } from "@/components/social/UsagePanel";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { listEngagements, listDailyMetrics, listPostMetrics, getEngagementUsage } from "@/lib/social";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ engagementId?: string }>;

// Analytics (SMM-11 route, SMM-21 backend) — reach/engagement/delivery metrics per network, read
// from `social_metrics_daily`/`social_post_metrics` via `metrics-job.ts#pullMetrics`'s nightly
// sweep (platform-nest). `GET metrics/daily`/`GET metrics/posts` both REQUIRE `engagementId` —
// accounts are client-scoped, not engagement-scoped (0105) — so this page always resolves one
// before reading either, exactly the pattern `calendar/page.tsx` already uses for its own
// engagement filter.
export default async function DepartmentSocialAnalyticsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const engagements = await listEngagements(userId, tenant);

  if (engagements.forbidden) {
    return (
      <Card title="Analytics">
        <AccessDenied what="view engagement analytics" />
      </Card>
    );
  }

  if (engagements.data.length === 0) {
    return (
      <Card title="Analytics">
        <EmptyNote>No engagements yet — analytics has nothing to scope to until one exists.</EmptyNote>
      </Card>
    );
  }

  const selectedEngagementId = sp.engagementId ?? engagements.data[0].id;
  const selected = engagements.data.find((e) => e.id === selectedEngagementId);

  if (!selected) {
    // A stale/foreign engagementId in the URL — same "unknown id reads as nothing to show" the
    // real endpoint itself answers (never a 500, never a guess at a substitute engagement).
    return (
      <Card title="Analytics">
        <EmptyNote>That engagement wasn&apos;t found. Pick one from the list below.</EmptyNote>
        {engagements.data.length > 1 && (
          <form method="get" aria-label="Engagement filter" style={{ marginTop: 12 }}>
            <select name="engagementId" defaultValue="">
              {engagements.data.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ marginLeft: 8 }}>Go</button>
          </form>
        )}
      </Card>
    );
  }

  const [daily, posts, usage] = await Promise.all([
    listDailyMetrics(userId, tenant, selectedEngagementId),
    listPostMetrics(userId, tenant, selectedEngagementId),
    getEngagementUsage(userId, tenant, selectedEngagementId),
  ]);

  if (daily.forbidden || posts.forbidden) {
    return (
      <Card title="Analytics">
        <AccessDenied what="view engagement analytics" />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Analytics"
        headerRight={
          engagements.data.length > 1 ? (
            <form method="get" aria-label="Engagement filter" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select name="engagementId" defaultValue={selectedEngagementId}>
                {engagements.data.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Filter</button>
            </form>
          ) : undefined
        }
      >
        <AnalyticsPanel dailySeries={daily.data} postMetrics={posts.data} />
      </Card>
      {/* SMM-22 — the usage/ledger panel design §08 names for this tab. `social.ledger.read` is a
          SEPARATE permission from the analytics reads above, so this renders independently even
          when a viewer lacks (or holds) only one of the two — never folded into the same
          `forbidden` check, which would conflate two different Cerbos decisions into one. */}
      <Card title="Metered spend (X)">
        {usage.forbidden ? <AccessDenied what="view metered spend" /> : <UsagePanel usage={usage.data} />}
      </Card>
    </>
  );
}
