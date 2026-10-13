import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listBriefs } from "@/lib/entities";
import { can, isLeadOf, leadUnits, unitPathOf } from "@/lib/rbac";
import { listDepartmentBriefs } from "@/lib/departments";
import { readCampaignDetail, readClientNames, readOrgRoot, readPersonChoices } from "@/lib/campaigns-data";
import { canEditPart, leadText, moneyView } from "@/lib/campaigns";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { BriefForm } from "@/components/forms/BriefForm";
import { CampaignParts } from "@/components/agency/CampaignParts";
import { CampaignEditor } from "@/components/agency/CampaignEditor";
import { createBrief } from "../actions";
import "@/components/agency/campaigns.css";

const BRIEF_COLUMNS = [{ label: "Title" }, { label: "Status" }, { label: "Created", align: "right" as const }];
const BRIEF_TCOLS = "2fr 1fr 1fr";

function datesText(startsOn: string | null, endsOn: string | null): string {
  if (startsOn && endsOn) return `${formatDate(startsOn)} to ${formatDate(endsOn)}`;
  if (startsOn) return `From ${formatDate(startsOn)}`;
  if (endsOn) return `Until ${formatDate(endsOn)}`;
  return "No dates set";
}

// DW-5b — the shared campaign page (contract §31). Reads `GET campaigns/:id` (the campaign, its money block and its
// parts), no longer a scan of the whole list. A 404 is `notFound()`; a refusal or a failed read is a <ReadRefusal>.
// Pilot and classic users both land here (the notification href is /agency/<id>); a department page links to it.
//
// What is offered is cosmetic and the server decides: managers (`agency.campaign.manage`) may add or remove a
// department, set allocations and edit the budget, currency, lead and dates; a part's owner, its department's head and a
// manager may edit the part's status, owner, brief and due date. The head check needs the org tree: when it cannot be
// read, only owners and managers are offered those controls (the server still lets the head through).
export default async function CampaignDetailPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const detailResult = await readCampaignDetail(userId, tenant, campaignId);
  if (detailResult.kind === "forbidden") {
    return (
      <>
        <PageHeader title="Campaign" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Campaign" }]} />
        <ReadRefusal subject="this campaign" kind="forbidden" />
      </>
    );
  }
  if (detailResult.kind === "unavailable") {
    return (
      <>
        <PageHeader title="Campaign" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Campaign" }]} />
        <ReadRefusal subject="This campaign" kind="unavailable" reason={detailResult.reason} />
      </>
    );
  }
  const campaign = detailResult.data;
  if (!campaign) notFound();

  const canManage = can(me, "agency.campaign.manage", tenant);
  // The org tree answers "is this person the head of that department": read it only when it can change the answer.
  const needHeads = !canManage && leadUnits(me).length > 0 && campaign.parts.length > 0;
  const [clients, people, departments, root, briefs] = await Promise.all([
    campaign.clientId ? readClientNames(userId, tenant) : Promise.resolve(null),
    readPersonChoices(userId, tenant),
    canManage ? listDepartmentBriefs(userId, tenant) : Promise.resolve([]),
    needHeads ? readOrgRoot(me, tenant) : Promise.resolve(null),
    // Briefs endpoints may not exist on the backend yet; listBriefs degrades to [] (see @/lib/entities skipUnavailable).
    listBriefs(userId, tenant, campaignId),
  ]);

  const money = moneyView(campaign.money);
  const clientValue: ReactNode = !campaign.clientId
    ? "—"
    : clients?.kind === "ok" && clients.data[campaign.clientId]
      ? <Link href={`/clients/${campaign.clientId}`}>{clients.data[campaign.clientId]}</Link>
      : "Unavailable";

  const items: { label: string; value: ReactNode }[] = [
    { label: "Status", value: <StatusBadge label={campaign.status} /> },
    { label: "Client", value: clientValue },
    {
      label: "Project",
      value: campaign.projectId ? <Link href={`/projects/${campaign.projectId}`}>{campaign.projectId}</Link> : "—",
    },
    { label: "Lead department", value: leadText(campaign.leadUnitId, campaign.leadUnitName) },
    { label: "Dates", value: datesText(campaign.startsOn, campaign.endsOn) },
  ];

  const partCards = campaign.parts.map((part) => ({
    part,
    canEdit: canEditPart({
      canManage,
      meId: me.userId,
      ownerId: part.ownerId,
      isHead: root && part.unitId ? isLeadOf(me, unitPathOf(root, part.unitId)) : false,
    }),
  }));

  return (
    <>
      <PageHeader eyebrow="Campaign" title={campaign.name} breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: campaign.name }]} />
      <DescriptionList items={items} />

      <div className="cmp-stack" style={{ marginTop: 28 }}>
        <Card title="Money">
          <dl className="cmp-money">
            <div className="cmp-money__item">
              <dt className="cmp-money__label">Budget</dt>
              <dd className={`cmp-money__value${money.hasBudget ? "" : " cmp-money__value--quiet"}`} style={{ margin: 0 }}>{money.budget}</dd>
            </div>
            <div className="cmp-money__item">
              <dt className="cmp-money__label">Allocated to parts</dt>
              <dd className="cmp-money__value" style={{ margin: 0 }}>{money.allocated}</dd>
            </div>
            <div className="cmp-money__item">
              <dt className="cmp-money__label">Unallocated</dt>
              <dd className={`cmp-money__value${campaign.money.unallocatedMinor === null ? " cmp-money__value--quiet" : ""}`} style={{ margin: 0 }}>{money.unallocated}</dd>
            </div>
          </dl>
          <p className="cmp-note" style={{ marginTop: 12 }}>
            Parts take their money from this budget. A department&apos;s own campaign keeps its own budget, shown beside its part and never added here.
          </p>
          {canManage && (
            <div style={{ marginTop: 16 }}>
              <CampaignEditor
                campaignId={campaign.id}
                budgetMinor={campaign.money.budgetMinor}
                currency={campaign.money.currency}
                leadUnitId={campaign.leadUnitId}
                leadUnitName={campaign.leadUnitName}
                startsOn={campaign.startsOn}
                endsOn={campaign.endsOn}
                departments={departments}
              />
            </div>
          )}
        </Card>

        <Card title="Parts" hint="One part per department taking part: its owner, status, allocation and the work linked to it.">
          <CampaignParts
            campaignId={campaign.id}
            currency={campaign.money.currency}
            hasBudget={money.hasBudget}
            parts={partCards}
            canManage={canManage}
            departments={departments}
            people={people.kind === "ok" ? people.data : null}
            linkAccess={campaign.linkAccess}
          />
        </Card>

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
