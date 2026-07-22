import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listAssignments, SERVICE_ASSIGNMENTS_ENABLED } from "@/lib/serviceAssignments";
import { listDepartmentBriefs } from "@/lib/departments";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ServiceAssignmentRow } from "@/components/org/ServiceAssignmentRow";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import "@/components/org/services.css";
import {
  acceptAssignmentAction, suspendAssignmentAction, resumeAssignmentAction,
  revokeAssignmentAction, reconcileAssignmentAction, relinkAssignmentAction,
} from "@/app/(app)/companies/[companyId]/org/actions";

const SUBTITLE =
  "Accept a proposed connection, and manage the shared-service assignments the active company " +
  "provides or receives — suspend, resume, revoke, re-link, or force a reconcile. ORG-13 (A9): the " +
  "\"Connect service\" button on a department/division card starts these; this page is where the " +
  "propose→accept→active→suspend→revoke lifecycle plays out.";

// Settings › Services (ORG-13). Tenant-scoped like every other /admin/*
// page — no cross-company aggregate invented here (the org-structure
// assignments endpoints are all `/api/:t/...`); a global exec who wants to
// see every company's assignments switches company like anywhere else.
export default async function AdminServicesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Services" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  if (!SERVICE_ASSIGNMENTS_ENABLED) {
    return (
      <>
        <PageHeader eyebrow="Settings" title="Services" subtitle={SUBTITLE} />
        <EmptyNote>Shared-service connections aren&apos;t enabled yet.</EmptyNote>
      </>
    );
  }

  const [provided, served, departments] = await Promise.all([
    listAssignments(userId, tenant, { direction: "provided" }),
    listAssignments(userId, tenant, { direction: "served" }),
    listDepartmentBriefs(userId, tenant).catch(() => []),
  ]);

  const awaitingAccept = served.items.filter((a) => a.status === "proposed");
  const servingUs = served.items.filter((a) => a.status !== "proposed" && a.status !== "revoked");
  const weProvide = provided.items.filter((a) => a.status !== "revoked");

  const accept = acceptAssignmentAction.bind(null, tenant);
  const suspend = suspendAssignmentAction.bind(null, tenant);
  const resume = resumeAssignmentAction.bind(null, tenant);
  const revoke = revokeAssignmentAction.bind(null, tenant);
  const reconcile = reconcileAssignmentAction.bind(null, tenant);
  const relink = relinkAssignmentAction.bind(null, tenant);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Services" subtitle={SUBTITLE} />

      <Card title="Awaiting your acceptance">
        {awaitingAccept.length === 0 ? (
          <EmptyNote>Nothing proposed to the active company right now.</EmptyNote>
        ) : (
          <ul className="svc-list">
            {awaitingAccept.map((a) => (
              <ServiceAssignmentRow
                key={a.id}
                a={a}
                label={`${a.providerCompanyName ?? a.providerTenantId} · ${a.unitName}`}
                actions={{ accept, revoke }}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="You provide" style={{ marginTop: 16 }}>
        <EnvelopeBanner companies={provided.companies} />
        {weProvide.length === 0 ? (
          <EmptyNote>The active company doesn&apos;t serve any other company yet — use &quot;Connect service&quot; on a department in the org structure editor.</EmptyNote>
        ) : (
          <ul className="svc-list">
            {weProvide.map((a) => (
              <ServiceAssignmentRow
                key={a.id}
                a={a}
                label={`${a.targetCompanyName ?? a.targetTenantId} · ${a.unitName}`}
                actions={{
                  suspend, resume, revoke, reconcile,
                  relink: departments.length > 0 ? { unitOptions: departments, run: relink } : undefined,
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Serving you" style={{ marginTop: 16 }}>
        <EnvelopeBanner companies={served.companies} />
        {servingUs.length === 0 ? (
          <EmptyNote>No other company currently serves the active company.</EmptyNote>
        ) : (
          <ul className="svc-list">
            {servingUs.map((a) => (
              <ServiceAssignmentRow
                key={a.id}
                a={a}
                label={`${a.providerCompanyName ?? a.providerTenantId} · ${a.unitName}`}
                actions={{ suspend, resume, revoke }}
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
