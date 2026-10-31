import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, StatusBadge, KpiTile } from "@/components/ui";
import { TrackingTagsCard } from "@/components/webdesk/analytics/TrackingTagsCard";
import { findTrackingSite, readTrackingTags } from "@/lib/trackingTags";
import { ScopeEditor } from "@/components/search/ScopeEditor";
import { ProviderModeStatement, SimulatedBadge } from "@/components/search/SimulatedBadge";
import {
  getEngagement,
  getEngagementScope,
  getCostProjection,
  listProperties,
  formatUsd,
  anyEnabledToolSimulated,
  type SearchProperty,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string; engagementId: string }>;

const NOT_BUILT_BY_ERP =
  "This client's website is not built by the ERP, so its Google Ads and LinkedIn tags are set on the website itself.";

/**
 * M5-P4g: the client's tracking tags (Google Ads and LinkedIn) for this engagement's search property. Which WebDesk site is the property's is
 * answered by the server (`findTrackingSite`, GET tracking-tags/site: `search_property . read`, company-scoped, the same domain rule as the
 * save path's binding), so a search manager with no Web Dev role still gets the card. Nothing here may break the page: a refused or failed
 * lookup is a sentence in the card's place, never a blank and never a thrown error; `site: null` is a plain note.
 */
async function trackingTagsSection(
  userId: string, tenant: string, property: SearchProperty, canEdit: boolean,
): Promise<ReactNode> {
  const found = await findTrackingSite(userId, tenant, property.id);
  if (found.kind !== "ok") {
    return <Card title="Tracking tags"><p className="wa-note" role="status" data-testid="engagement-tags-unavailable">{found.message}</p></Card>;
  }
  const site = found.data.site;
  if (!site) return <Card title="Tracking tags"><p className="wa-note" data-testid="engagement-tags-not-built">{NOT_BUILT_BY_ERP}</p></Card>;
  const read = await readTrackingTags(userId, tenant, property.id, site.webdeskTenant, site.site);
  return <TrackingTagsCard propertyId={property.id} webdeskTenant={site.webdeskTenant} site={site.site} read={read} canEdit={canEdit} />;
}

// Engagement detail — the drill-down from the engagements list (SM-11). This
// page exists to answer one question a client-facing person will actually ask:
// "why did the rankings/backlinks/whatever pull not happen?" The answer is
// always the same shape — a metered capability rides one tool-scope toggle
// (D-11), and that toggle is either explicitly `enabled: true` or it is OFF,
// full stop, absent included. The scope editor (SM-29, <ScopeEditor>) is the
// whole point of the page; everything else is context around it.
export default async function EngagementDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, engagementId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  // getEngagementScope and getCostProjection both degrade (404/403 -> {}/null)
  // per lib/searchMarketing's skipUnavailable, so a Cerbos denial or a not-yet-
  // enabled module never blanks the whole page — only the sections that need
  // the missing data fall back to their own "we don't know" state.
  const [engagement, scope, projection, properties] = await Promise.all([
    getEngagement(userId, tenant, engagementId),
    getEngagementScope(userId, tenant, engagementId),
    getCostProjection(userId, tenant, engagementId),
    listProperties(userId, tenant),
  ]);

  if (!engagement) notFound();

  const propertyById = new Map<string, SearchProperty>(properties.map((p) => [p.id, p]));
  const property = engagement.propertyId ? propertyById.get(engagement.propertyId) : undefined;

  const canWriteScope = can(me, "search.scope.write", tenant);
  // SM-38: a total built from simulated inputs is itself simulated — badge the aggregate KPI the
  // same way ScopeEditor badges its own preview total, from the SAME `perTool[].simulated` rows.
  const projectionSimulated = projection ? anyEnabledToolSimulated(projection.perTool) : false;

  return (
    <>
      {/* 1. Header — who this engagement is, its status, its property, its budget, and the
          platform's data mode (SM-38 deliverable #2) so an operator can tell at a glance which
          mode they're looking at without inferring it from chips scattered further down the page. */}
      <Card title={engagement.name} headerRight={<StatusBadge label={engagement.status} />}>
        <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "center", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Property:</strong>{" "}
            {property ? property.domain : "—"}
          </span>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Provider budget:</strong>{" "}
            {formatUsd(engagement.providerBudgetUsd)}/mo
          </span>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Starts:</strong>{" "}
            {engagement.startsOn ? new Date(engagement.startsOn).toLocaleDateString() : "—"}
          </span>
          <ProviderModeStatement mode={projection?.providerMode ?? null} />
        </div>
      </Card>

      {/* 2. KPI strip. A missing projection must never render as "$0.00" — that
          reads as "this costs nothing" when the truth is "we don't know yet". */}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", margin: "16px 0" }}>
        <KpiTile
          label="Projected monthly cost"
          value={
            <>
              {projection ? formatUsd(projection.totalMonthlyUsd) : "—"}
              {projectionSimulated && <SimulatedBadge />}
            </>
          }
          foot={projection ? undefined : "Cost-projection endpoint did not answer"}
        />
        <KpiTile label="Provider budget" value={formatUsd(engagement.providerBudgetUsd)} />
        <KpiTile
          label="Over budget"
          value={
            <>
              {projection ? (projection.overBudget ? "Yes" : "No") : "—"}
              {projectionSimulated && <SimulatedBadge />}
            </>
          }
          foot={projection ? undefined : "Unknown — no projection"}
        />
      </div>

      {/* 3. Metered tools — the editable scope-config surface (SM-29). Read-only for a viewer
          without search.scope.write (rule: the UI gate is a hint, not the boundary — a
          non-privileged user still gets the same information, just inert controls). */}
      <Card title="Metered tools">
        <ScopeEditor
          tenantId={tenant}
          engagementId={engagementId}
          canWrite={canWriteScope}
          initialScopePreset={scope.scopePreset}
          initialToolScope={scope.toolScope}
          initialProviderBudgetUsd={scope.providerBudgetUsd ?? engagement.providerBudgetUsd}
          initialProjection={projection}
        />
      </Card>

      {/* 3b. Tracking tags (M5-P4g): Google Ads and LinkedIn for this client's website, when the ERP builds it. */}
      {property ? (
        <div style={{ marginTop: 16 }}>
          {await trackingTagsSection(userId, tenant, property, can(me, "search.tags.manage", tenant))}
        </div>
      ) : null}

      {/* 4. Stop-loss warning — only when the PERSISTED projection actually says so (the editor
          above shows its own live warning while unsaved edits are in progress). */}
      {projection?.overBudget && (
        <div
          role="alert"
          style={{
            border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-danger, var(--status-critical))",
            background: "color-mix(in srgb, var(--status-critical) 6%, transparent)", padding: "12px 14px", marginTop: 16,
            font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)",
          }}
        >
          <strong style={{ color: "var(--erp-danger, var(--status-critical-fg))" }}>Over budget:</strong> the configured
          scope is projected to exceed this engagement&apos;s provider budget ({formatUsd(engagement.providerBudgetUsd)}/mo).
          Pulls will be refused by the stop-loss once the cap is reached this period, even for toggles that
          are switched on.
        </div>
      )}
    </>
  );
}
