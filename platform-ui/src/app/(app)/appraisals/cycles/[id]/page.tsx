import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getAppraisalCycle, listAppraisals, getAppraisal, isForbidden, isNotFound } from "@/lib/appraisals-data";
import { listMembers } from "@/lib/entities";
import { patchAppraisalCycle, generateAppraisals } from "@/lib/appraisalActions";
import { PageHeader } from "@/components/PageHeader";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card, StatusBadge } from "@/components/ui";
import { CycleStatusControl } from "@/components/reports/appraisals/CycleStatusControl";
import { WeightsEditor } from "@/components/reports/appraisals/WeightsEditor";
import { GenerateForm } from "@/components/reports/appraisals/GenerateForm";
import "@/components/reports/appraisals/appraisals.css";

export default async function AppraisalCycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { id } = await params;
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Cycle" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }
  if (!can(me, "appraisal.cycle.admin", tenant)) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Cycle" />
        <ReportAccessDenied reason="Cycle administration is an HR / company-admin capability." />
      </>
    );
  }

  try {
    const [cycle, membersRaw, { appraisals }] = await Promise.all([
      getAppraisalCycle(tenant, userId, id),
      listMembers(userId, tenant),
      listAppraisals(tenant, userId, { cycleId: id }),
    ]);
    const members = membersRaw.map((m) => ({ userId: m.user_id, name: m.name, title: m.title }));
    // Hydrate each row's real name via `GET /appraisals/:id` rather than trusting `listMembers`'
    // roster — a subject can be scored by a manager outside their own company membership listing
    // (this cycle's tenant-scoped member roster is not the same set `generate`'s roster drew from),
    // so falling back to the raw subjectUserId here would be a cosmetic regression on exactly the
    // kind of cross-membership case this program's org model already allows.
    const hydratedAppraisals = await Promise.all(appraisals.map((a) => getAppraisal(tenant, userId, a.id)));

    return (
      <>
        <PageHeader
          eyebrow="Appraisals"
          title={cycle.name}
          subtitle={`${cycle.periodStart} — ${cycle.periodEnd}`}
          actions={<Link href="/appraisals/cycles" className="lux-btn lux-btn--ghost lux-btn--sm">All cycles</Link>}
        />
        <Card title="Status" style={{ marginBottom: 20 }}>
          <CycleStatusControl cycleId={cycle.id} status={cycle.status} patchAction={patchAppraisalCycle} />
        </Card>
        <Card title="Weights" style={{ marginBottom: 20 }}>
          <WeightsEditor cycleId={cycle.id} defaultWeights={cycle.defaultWeights} roleWeights={cycle.roleWeights} patchAction={patchAppraisalCycle} />
        </Card>
        <GenerateForm cycleId={cycle.id} members={members} generateAction={generateAppraisals} />
        <Card title="Appraisals in this cycle">
          {hydratedAppraisals.length === 0 ? (
            <EmptyNote>None generated yet.</EmptyNote>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {hydratedAppraisals.map((a) => (
                <Link
                  key={a.id} href={`/appraisals/${a.id}`}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "0.5px solid var(--erp-hairline)", textDecoration: "none", color: "inherit" }}
                >
                  <span>{a.subjectName}</span>
                  <StatusBadge label={a.status} />
                  {a.evidenceStale && <span style={{ font: "700 10px var(--font-body)", color: "var(--erp-accent)" }}>EVIDENCE STALE</span>}
                </Link>
              ))}
            </div>
          )}
        </Card>
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Cycle" />
          <ReportAccessDenied reason="Cycle administration is an HR / company-admin capability." />
        </>
      );
    }
    if (isNotFound(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Cycle" />
          <EmptyNote>This cycle doesn&rsquo;t exist.</EmptyNote>
        </>
      );
    }
    throw e;
  }
}
