import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { ReportsPanel } from "@/components/search/ReportsPanel";
import { listEngagements, listReports, previewReport, type SearchEngagement } from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ engagementId?: string; reportId?: string }>;

// Reports — the client-facing artifact this whole department ultimately produces (SM-22; design
// §12). SM-10 drafted the narrative-generation backend and SM-18 gave the console shell; this page
// replaces the PendingCapability placeholder that stood since SM-11 (tracker: "the Reports tab is
// still a stub until SM-22 lands").
//
// Selection is by ENGAGEMENT (mirrors Rankings/Keywords), since reports are per-engagement
// (search_reports.engagement_id). The selected REPORT is a second, independent searchParam so a
// reviewer can deep-link straight to one from a notification (`search.report.ready_for_review`'s own
// href already points here — see notifications.ts's HREF map).
export default async function DepartmentSeoReportsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
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
  const canApprove = can(me, "search.report.approve", tenant);

  const engagements = await listEngagements(userId, tenant);
  const engagementId = sp.engagementId && engagements.some((e) => e.id === sp.engagementId) ? sp.engagementId : engagements[0]?.id;
  const engagement = engagements.find((e) => e.id === engagementId);

  const reports = engagementId ? await listReports(userId, tenant, engagementId) : [];
  const selectedReportId = sp.reportId && reports.some((r) => r.id === sp.reportId) ? sp.reportId : undefined;
  const selectedPreview = selectedReportId ? await previewReport(userId, tenant, selectedReportId) : null;

  return (
    <Card title="Reports">
      {engagements.length === 0 ? (
        <TeachState
          glyph="▤"
          title="No engagements yet"
          body="Client reports belong to a client engagement — set one up from the Engagements tab first."
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

          {!engagement ? (
            <TeachState
              glyph="⚑"
              title="Engagement not found"
              body="Pick a different engagement above."
              ctaLabel="Go to Engagements"
              ctaHref={`/departments/${deptId}/engagements`}
            />
          ) : (
            <ReportsPanel
              tenantId={tenant} engagementId={engagement.id} reports={reports}
              selectedReportId={selectedReportId} selectedPreview={selectedPreview}
              canManage={canManage} canApprove={canApprove}
            />
          )}
        </>
      )}
    </Card>
  );
}
