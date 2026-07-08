import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getCampaign, listBriefs } from "@/lib/entities";
import { formatBudget } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { BriefForm } from "@/components/forms/BriefForm";
import { createBrief } from "../actions";

const BRIEF_COLUMNS = [{ label: "Title" }, { label: "Status" }, { label: "Created", align: "right" as const }];
const BRIEF_TCOLS = "2fr 1fr 1fr";

export default async function CampaignDetailPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const campaign = await getCampaign(userId, tenant, campaignId);
  if (!campaign) notFound();

  // Briefs endpoints may not exist on the backend yet; listBriefs degrades to []
  // (see @/lib/entities skipUnavailable) so this section is always safe to render.
  const briefs = await listBriefs(userId, tenant, campaignId);

  const items: { label: string; value: ReactNode }[] = [
    { label: "Status", value: <StatusBadge label={campaign.status} /> },
    { label: "Budget", value: formatBudget(campaign.budget_minor, campaign.currency) },
    {
      label: "Project",
      value: campaign.project_id ? <Link href={`/projects/${campaign.project_id}`}>{campaign.project_id}</Link> : "—",
    },
  ];

  return (
    <>
      <PageHeader eyebrow="Campaign" title={campaign.name} />
      <DescriptionList items={items} />
      <div style={{ marginTop: 28 }}>
        <Card title="Briefs">
          {briefs.length === 0 ? (
            <div className="dash-empty">
              <p>No briefs yet.</p>
            </div>
          ) : (
            <HairlineTable
              tcols={BRIEF_TCOLS}
              columns={BRIEF_COLUMNS}
              rows={briefs.map((b) => [
                b.title,
                <StatusBadge key={`${b.id}-status`} label={b.status} />,
                b.created_at,
              ])}
            />
          )}
          <div style={{ marginTop: 20 }}>
            <BriefForm action={createBrief.bind(null, campaignId)} />
          </div>
        </Card>
      </div>
    </>
  );
}
