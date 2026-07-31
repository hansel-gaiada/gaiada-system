import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getAppraisal, isForbidden, isNotFound } from "@/lib/appraisals-data";
import { PageHeader } from "@/components/PageHeader";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AppraisalPackView } from "@/components/reports/appraisals/AppraisalPackView";
import { AckDisputeForm } from "@/components/reports/appraisals/AckDisputeForm";
import { FinalizeControl } from "@/components/reports/appraisals/FinalizeControl";
import { ManagerScoringForm } from "@/components/reports/appraisals/ManagerScoringForm";
import { ackAppraisal, confirmAppraisalEvidence, finalizeAppraisal, patchAppraisalScores, submitAppraisal } from "@/lib/appraisalActions";

// TR-26 — one appraisal pack. Which footer control renders is decided ENTIRELY by who the caller
// is relative to the pack (subject / assigned manager / HR) — the pack's own content
// (`AppraisalPackView`) never branches on that (see its own header comment, the ticket's fairness
// core). A draft is the one exception: only the assigned manager may even open the editing form,
// and the server itself 403s a subject trying to read a draft — this page just renders whatever the
// BFF actually answered or denied, exactly like every other reports/appraisal surface.
export default async function AppraisalPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { id } = await params;
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Appraisal" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  try {
    const pack = await getAppraisal(tenant, userId, id);
    const isManager = userId === pack.managerUserId;
    const isSubject = userId === pack.subjectUserId;
    const isHR = can(me, "appraisal.cycle.admin", tenant);

    if (pack.status === "draft") {
      if (!isManager) {
        // HR/exec broad-read tiers may land here (they can read a draft), but only the assigned
        // manager may score it — render read-only rather than a form nobody but them can submit.
        return (
          <>
            <PageHeader eyebrow="Appraisals" title={`${pack.subjectName}'s appraisal`} subtitle="Draft — not yet submitted." />
            <AppraisalPackView pack={pack} />
          </>
        );
      }
      return (
        <ManagerScoringForm
          pack={pack}
          patchAction={patchAppraisalScores}
          submitAction={submitAppraisal}
          confirmEvidenceAction={confirmAppraisalEvidence}
        />
      );
    }

    const footerSlot = isSubject
      ? <AckDisputeForm appraisalId={pack.id} ackAction={ackAppraisal} />
      : isHR
        ? <FinalizeControl appraisalId={pack.id} evidenceStale={pack.evidenceStale} status={pack.status} finalizeAction={finalizeAppraisal} confirmEvidenceAction={confirmAppraisalEvidence} />
        : undefined;

    return (
      <>
        <PageHeader eyebrow="Appraisals" title={`${pack.subjectName}'s appraisal`} subtitle={pack.cycleName} />
        <AppraisalPackView pack={pack} footerSlot={footerSlot} />
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Appraisal" />
          <ReportAccessDenied reason="You can only view your own appraisal once it's submitted, an appraisal you're the assigned manager for, or — for HR/exec — any appraisal in the tenant." />
        </>
      );
    }
    if (isNotFound(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Appraisal" />
          <EmptyNote>This appraisal doesn&rsquo;t exist.</EmptyNote>
        </>
      );
    }
    throw e;
  }
}
