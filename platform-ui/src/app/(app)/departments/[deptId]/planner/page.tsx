import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { GeneratePlanForm } from "@/components/search/GeneratePlanForm";
import { NewCampaignForm } from "@/components/search/NewCampaignForm";
import { formatBudget } from "@/lib/format";
import {
  listEngagements, listCampaigns, listKeywordSets, numOrNull,
  type SearchEngagement,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ engagementId?: string }>;

// Planner — SM-18's cluster→plan generator + campaign list (SM-47). Campaigns hang off an
// engagement (`engagements/:id/campaigns`), same "pick an engagement first" pattern the Keywords
// tab uses for keyword sets. Planning + drafting create NO live ad-account changes (design §12
// SM-18's "done when": campaign/ad/negative/change-proposal status writes are restricted to
// ERP-side draft states everywhere, and 'applied' is refused server-side) — this tab stays FREE
// tier and must never imply a push to a real account is possible from here.
export default async function DepartmentSeoPlannerPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
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

  const [campaigns, keywordSets] = engagementId
    ? await Promise.all([listCampaigns(userId, tenant, engagementId), listKeywordSets(userId, tenant, engagementId)])
    : [[], []];

  return (
    <>
      <Card title="Planner" headerRight={<CostTierBadge tier="free" />}>
        {engagements.length === 0 ? (
          <TeachState
            glyph="◇"
            title="No engagements yet"
            body="Campaigns belong to a client engagement — set one up from the Engagements tab first."
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

            {campaigns.length === 0 ? (
              <TeachState
                glyph="◇"
                title="Nothing planned yet"
                body="No campaigns exist for this engagement. Generate one from a clustered keyword set below, or create an empty campaign shell to build up manually."
              />
            ) : (
              <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "360px" }}>
                <HairlineTable
                  columns={[
                    { label: "Campaign" }, { label: "Platform" }, { label: "Status" }, { label: "Budget", align: "right" },
                  ]}
                  rows={campaigns.map((c) => [
                    <Link key="n" href={`/departments/${deptId}/planner/${c.id}`}>{c.name}</Link>,
                    c.platform === "google_ads" ? "Google Ads" : c.platform === "microsoft_ads" ? "Microsoft Ads" : c.platform,
                    <StatusBadge key="s" label={c.status} />,
                    formatBudget(numOrNull(c.budgetMinor), c.currency),
                  ])}
                  tcols="1.8fr 1fr .8fr 1fr"
                />
              </div>
            )}
          </>
        )}
      </Card>

      {canManage && engagementId && (
        <Card title="Generate a plan from a keyword set">
          <GeneratePlanForm tenantId={tenant} engagementId={engagementId} deptId={deptId} keywordSets={keywordSets} />
        </Card>
      )}

      {canManage && engagementId && (
        <Card title="Or start a campaign manually">
          <NewCampaignForm tenantId={tenant} engagementId={engagementId} deptId={deptId} />
        </Card>
      )}

      {!canManage && engagements.length > 0 && (
        <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 12 }}>
          Creating or generating a campaign needs the <code>search.manage</code> permission.
        </p>
      )}
    </>
  );
}
