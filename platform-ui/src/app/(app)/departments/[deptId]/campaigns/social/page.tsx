import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { NewSocialCampaignForm } from "@/components/social/NewSocialCampaignForm";
import { SocialCampaignLink } from "@/components/social/SocialCampaignLink";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { ourPartChoices, socialLinkIndex } from "@/lib/campaigns";
import { readDetailsOf, readSharedCampaigns, readSocialCampaigns, readSocialEngagements } from "@/lib/campaigns-data";
import "@/components/agency/campaigns.css";

type Params = Promise<{ deptId: string }>;

const COLUMNS = [{ label: "Campaign" }, { label: "Engagement" }, { label: "Status" }, { label: "Goal" }, { label: "Shared campaign" }];
const TCOLS = "1.8fr 1.3fr 0.9fr 1.8fr 2.6fr";

// DW-5b — Social Media › Campaigns › Social campaigns (plan §7.1). The department's own social campaigns (the §19
// reader, here as a ReadResult so a refusal is never an empty list), a form to create one, and "link to a shared
// campaign": a social campaign can be that department's work inside a shared campaign where it has a part (contract
// §31.4 links). Which social campaign sits in which shared campaign is read from the details of the shared campaigns
// this department has a part in; when any of those cannot be read, the page says the link status is unavailable
// instead of claiming "not linked".
export default async function DepartmentSocialCampaignsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [campaigns, engagements, shared] = await Promise.all([
    readSocialCampaigns(userId, tenant),
    readSocialEngagements(userId, tenant),
    readSharedCampaigns(userId, tenant, deptId),
  ]);
  if (campaigns.kind === "forbidden") return <ReadRefusal subject="this department's social campaigns" kind="forbidden" />;
  if (campaigns.kind === "unavailable") {
    return <ReadRefusal subject="The social campaigns" kind="unavailable" reason={campaigns.reason} />;
  }

  // Link state needs the shared campaigns where we have a part, and the links read off each of them.
  const choices = shared.kind === "ok" ? ourPartChoices(shared.data) : [];
  const detailsRead = shared.kind === "ok" ? await readDetailsOf(userId, tenant, choices.map((c) => c.campaignId)) : null;
  const linkIndex = detailsRead ? socialLinkIndex(detailsRead.details, deptId) : new Map();
  const socialAccessOk = detailsRead ? detailsRead.details.every((d) => d.linkAccess.socialCampaigns === "ok") : false;
  const linkStatus: "known" | "unknown" = detailsRead && detailsRead.unreadable === 0 && socialAccessOk ? "known" : "unknown";

  const engagementName = (id: string) => {
    if (engagements.kind !== "ok") return "Unavailable";
    return engagements.data.find((e) => e.id === id)?.name ?? "—";
  };
  const rows = campaigns.data;
  const canCreate = can(me, "social.manage", tenant);

  return (
    <div className="cmp-stack">
      <Card title="Social campaigns" hint="This department's own campaigns. Each can stand alone or be linked into a shared campaign as our part's work.">
        {rows.length === 0 ? (
          <p className="cmp-empty">No social campaigns yet.</p>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={rows.map((c) => [
              c.name,
              engagementName(c.engagementId),
              <StatusBadge key={`${c.id}-s`} label={c.status} />,
              c.goal ?? "—",
              <SocialCampaignLink
                key={`${c.id}-l`}
                socialCampaignId={c.id}
                linked={linkIndex.get(c.id) ?? null}
                linkStatus={linkStatus}
                choices={choices}
              />,
            ])}
          />
        )}
        {shared.kind === "forbidden" && (
          <p className="cmp-note" style={{ marginTop: 12 }}>You cannot see the shared campaigns, so linking is unavailable.</p>
        )}
        {shared.kind === "unavailable" && (
          <p className="cmp-note" style={{ marginTop: 12 }}>The shared campaigns could not be read ({shared.reason}), so linking is unavailable.</p>
        )}
        {shared.kind === "ok" && linkStatus === "unknown" && (
          <p className="cmp-note" style={{ marginTop: 12 }}>
            Some shared campaigns&apos; links could not be read, so a campaign that shows no link here may still be linked.
          </p>
        )}
      </Card>

      {canCreate && (
        <Card title="New social campaign">
          {engagements.kind === "ok" ? (
            engagements.data.length === 0 ? (
              <p className="cmp-empty">A social campaign belongs to an engagement, and this company has none yet.</p>
            ) : (
              <NewSocialCampaignForm tenantId={tenant} engagements={engagements.data.map((e) => ({ id: e.id, name: e.name }))} />
            )
          ) : (
            <p className="cmp-note">The engagements could not be read, so a campaign cannot be created now.</p>
          )}
        </Card>
      )}
    </div>
  );
}
