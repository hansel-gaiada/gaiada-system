import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listAgencyLeadsQueue } from "@/lib/agencyLeads-data";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PageHeader } from "@/components/PageHeader";
import { AgencyLeadsQueue } from "@/components/agency/AgencyLeadsQueue";
import { createLeadAction } from "./actions";

// AD-11 — the discovery-intake triage queue. Contract's rule 1 (docs/FRONTEND-BFF-CONTRACT.md,
// "Agency Discovery Intake"): the BFF already orders rows by WHOSE MOVE IT IS
// (submitted → new → invited → the rest, oldest-first within each) — this page renders that order
// verbatim and must never re-sort by date (see lib/agencyLeads.ts::queueRank's own header).
export default async function AgencyLeadsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/agency");

  const result = await listAgencyLeadsQueue(userId, tenant);

  // Contract rule 3: a denial must never render as an empty queue. `forbidden`/`unavailable` get
  // their own explicit page, not a "no leads yet" teach-state that would be a lie for this viewer.
  if (result.kind === "forbidden") {
    return (
      <>
        <PageHeader title="Discovery leads" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads" }]} />
        <ReadRefusal subject="the discovery-intake queue" kind="forbidden" />
      </>
    );
  }
  if (result.kind === "unavailable") {
    return (
      <>
        <PageHeader title="Discovery leads" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads" }]} />
        <ReadRefusal subject="The discovery-intake queue" kind="unavailable" reason={result.reason} />
      </>
    );
  }

  const canCreate = can(me, "agency.lead.write", tenant);

  return (
    <>
      <PageHeader title="Discovery leads" breadcrumbs={[{ label: "Agency", href: "/agency" }, { label: "Discovery leads" }]} />
      <AgencyLeadsQueue rows={result.data} canCreate={canCreate} createAction={createLeadAction} />
    </>
  );
}
