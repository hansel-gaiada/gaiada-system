import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listMembers } from "@/lib/entities";
import { getAgencyLeadDetail, listAgencyLeadSubmissions } from "@/lib/agencyLeads-data";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PageHeader } from "@/components/PageHeader";
import { AgencyLeadDetail } from "@/components/agency/AgencyLeadDetail";
import {
  convertLeadAction, declineLeadAction, inviteLeadAction, nurtureLeadAction, openLeadAction, revokeInviteAction,
} from "../actions";

type Params = Promise<{ leadId: string }>;

// AD-11 — lead detail / review. Renders all 127 discovery answers grouped by the questionnaire's own
// 13 sections (contract rule 4: an unanswered OPTIONAL field must render as visibly skipped, never as
// a blank value), surfaces redactions + the supersedes_id chain, and hosts the triage/invite/convert
// actions gated per docs/FRONTEND-BFF-CONTRACT.md's rule 2 ("convert is a distinct, NARROWER Cerbos
// action than triage — gate the control on convert, not triage").
export default async function AgencyLeadDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { leadId } = await params;

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/agency");

  const detailResult = await getAgencyLeadDetail(userId, tenant, leadId);

  // Contract rule 3: a 403 renders as an explicit refusal, never as "lead not found".
  if (detailResult.kind === "forbidden") {
    return (
      <>
        <PageHeader title="Lead" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads", href: "/agency/leads" }, { label: "Not available" }]} />
        <ReadRefusal subject="this lead" kind="forbidden" />
      </>
    );
  }
  if (detailResult.kind === "unavailable") {
    return (
      <>
        <PageHeader title="Lead" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads", href: "/agency/leads" }, { label: "Unavailable" }]} />
        <ReadRefusal subject="This lead" kind="unavailable" reason={detailResult.reason} />
      </>
    );
  }
  const lead = detailResult.data;
  if (!lead) redirect("/agency/leads");

  // The submission-history read is a SEPARATE Cerbos resource (contract rule 6) — its own refusal is
  // rendered inline (never silently merged into the lead detail, which already succeeded above).
  const submissionsResult = await listAgencyLeadSubmissions(userId, tenant, leadId);

  const canWrite = can(me, "agency.lead.write", tenant);
  const canTriage = can(me, "agency.lead.triage", tenant);
  // Contract rule 2, verbatim: convert is gated on ITS OWN capability, never on triage.
  const canConvert = can(me, "agency.lead.convert", tenant);

  const members = canConvert ? await listMembers(userId, tenant).catch(() => []) : [];

  return (
    <>
      <PageHeader
        title={lead.orgName}
        breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads", href: "/agency/leads" }, { label: lead.orgName }]}
      />
      <AgencyLeadDetail
        lead={lead}
        submissionsResult={submissionsResult}
        members={members.map((m) => ({ id: m.user_id, name: m.name }))}
        canWrite={canWrite}
        canTriage={canTriage}
        canConvert={canConvert}
        actions={{
          invite: inviteLeadAction,
          revoke: revokeInviteAction,
          open: openLeadAction,
          decline: declineLeadAction,
          nurture: nurtureLeadAction,
          convert: convertLeadAction,
        }}
      />
    </>
  );
}
