import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { CostLedgerPanel } from "@/components/search/CostLedgerPanel";
import { ProviderModeStatement } from "@/components/search/SimulatedBadge";
import { listEngagements, getEngagementLedger, type SearchEngagement } from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async — same convention as the audit tab's property filter.
type SearchParams = Promise<{ engagementId?: string }>;

// SM-17 — the ledger/cost surface's own tab (design addendum §A3; tracker §6j). The FIRST UI onto
// the money ledger. A cost ledger is inherently per-ENGAGEMENT (the tenant scope + the property/
// engagement it was billed against), so this tab picks one engagement — same GET-form selector
// pattern as the Site Audit tab's property picker — rather than trying to blend every engagement's
// ledger into one cross-client total, which the design addendum explicitly rules out (§A3: a
// blended per-client figure is "computed, not assumed", and not this ticket's job).
export default async function DepartmentSeoLedgerPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;

  // Degrades to [] on 404/403 (module disabled for this tenant, or a Cerbos denial), same as every
  // other tab in this console.
  const engagements = await listEngagements(userId, tenant);
  const engagementId = sp.engagementId && engagements.some((e) => e.id === sp.engagementId)
    ? sp.engagementId
    : engagements[0]?.id;

  const ledger = engagementId ? await getEngagementLedger(userId, tenant, engagementId) : null;

  return (
    <Card title="Cost Ledger" headerRight={<CostTierBadge tier="data_key" />}>
      {engagements.length === 0 ? (
        <TeachState
          glyph="⚑"
          title="No engagements yet"
          body="A cost ledger tracks metered provider calls against one client engagement — create an engagement from the Engagements tab first."
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

          {ledger && (
            <div style={{ marginBottom: 16 }}>
              <ProviderModeStatement mode={ledger.providerMode} />
            </div>
          )}

          <CostLedgerPanel ledger={ledger} />
        </>
      )}
    </Card>
  );
}
