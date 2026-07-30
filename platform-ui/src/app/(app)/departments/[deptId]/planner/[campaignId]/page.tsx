import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, StatusBadge } from "@/components/ui";
import { CampaignStatusControl } from "@/components/search/CampaignStatusControl";
import { AdGroupsPanel } from "@/components/search/AdGroupsPanel";
import { AdsPanel } from "@/components/search/AdsPanel";
import { NegativesPanel } from "@/components/search/NegativesPanel";
import { ChangeProposalsPanel } from "@/components/search/ChangeProposalsPanel";
import { formatBudget } from "@/lib/format";
import {
  getCampaign, listAdGroups, listAds, listNegatives, listChangeProposals, numOrNull, numberOrDash,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string; campaignId: string }>;
type SearchParams = Promise<{ adGroupId?: string }>;

// Campaign detail (SM-47) — the drill-down from the Planner list. Ad groups, ads, negatives and
// change proposals for ONE campaign all live here rather than as separate top-level tabs, because
// every one of those objects is meaningless without a campaign to hang off — same "detail page holds
// the sub-objects" shape the engagement detail page already uses for its scope editor. Nothing here
// can reach a live ad account: campaign/ad/negative/change-proposal status writes are restricted to
// their ERP-side draft states everywhere (SM-18's own constraint, enforced server-side), and
// 'applied' is refused (400) regardless of what this page might try to send.
export default async function CampaignDetailPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, campaignId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const campaign = await getCampaign(userId, tenant, campaignId);
  if (!campaign) notFound();

  const sp = await searchParams;
  const canManage = can(me, "search.manage", tenant);

  const [adGroups, negatives, changeProposals] = await Promise.all([
    listAdGroups(userId, tenant, campaignId),
    listNegatives(userId, tenant, campaignId),
    listChangeProposals(userId, tenant, campaignId),
  ]);

  const adGroupId = sp.adGroupId && adGroups.some((g) => g.id === sp.adGroupId) ? sp.adGroupId : undefined;
  const ads = adGroupId ? await listAds(userId, tenant, adGroupId) : [];

  const platformLabel = campaign.platform === "google_ads" ? "Google Ads" : campaign.platform === "microsoft_ads" ? "Microsoft Ads" : campaign.platform;

  return (
    <>
      <Card
        title={campaign.name}
        headerRight={
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <StatusBadge label={campaign.status} />
            {canManage && <CampaignStatusControl tenantId={tenant} campaignId={campaignId} status={campaign.status} />}
          </div>
        }
      >
        <div style={{ display: "flex", gap: 32, flexWrap: "wrap", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          <span><strong style={{ color: "var(--text-primary)" }}>Platform:</strong> {platformLabel}</span>
          <span><strong style={{ color: "var(--text-primary)" }}>Objective:</strong> {campaign.objective ?? "—"}</span>
          <span><strong style={{ color: "var(--text-primary)" }}>Budget:</strong> {formatBudget(numOrNull(campaign.budgetMinor), campaign.currency)}</span>
          <span><strong style={{ color: "var(--text-primary)" }}>Bid strategy:</strong> {campaign.bidStrategy ?? "—"}</span>
          <span><strong style={{ color: "var(--text-primary)" }}>Target CPA:</strong> {formatBudget(numOrNull(campaign.targetCpaMinor), campaign.currency)}</span>
          <span><strong style={{ color: "var(--text-primary)" }}>Target ROAS:</strong> {campaign.targetRoas === null ? "—" : `${numberOrDash(campaign.targetRoas)}x`}</span>
        </div>
      </Card>

      <Card title="Ad groups">
        <AdGroupsPanel
          tenantId={tenant} deptId={deptId} campaignId={campaignId}
          adGroups={adGroups} selectedAdGroupId={adGroupId} canManage={canManage}
        />
      </Card>

      {adGroupId ? (
        <Card title={`Ads — ${adGroups.find((g) => g.id === adGroupId)?.name ?? adGroupId}`}>
          <AdsPanel tenantId={tenant} campaignId={campaignId} adGroupId={adGroupId} ads={ads} canManage={canManage} />
        </Card>
      ) : adGroups.length > 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)", margin: "8px 0 0" }}>
          Select an ad group above to see and draft its ads.
        </p>
      ) : null}

      <Card title="Negative keywords">
        <NegativesPanel tenantId={tenant} campaignId={campaignId} negatives={negatives} canManage={canManage} />
      </Card>

      <Card title="Change proposals">
        <ChangeProposalsPanel tenantId={tenant} campaignId={campaignId} proposals={changeProposals} canManage={canManage} />
      </Card>

      {!canManage && (
        <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 12 }}>
          Editing this campaign, its ad groups/ads/negatives, or its change proposals needs the
          <code> search.manage</code> permission.
        </p>
      )}
    </>
  );
}
