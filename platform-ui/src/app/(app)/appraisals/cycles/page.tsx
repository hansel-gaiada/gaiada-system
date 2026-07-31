import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getAppraisalCycles, isForbidden } from "@/lib/appraisals-data";
import { createAppraisalCycle } from "@/lib/appraisalActions";
import { PageHeader } from "@/components/PageHeader";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { StatusBadge } from "@/components/ui";
import { CycleForm } from "@/components/reports/appraisals/CycleForm";
import "@/components/reports/appraisals/appraisals.css";

// TR-26 — the HR appraisal-cycle console (deliverable 1: "cycle CRUD, weights/role-weights config,
// open/close, generate"). Gated on `appraisal.cycle.admin` (rbac.ts — TR-25's mirror; hr_manager,
// company_admin, and the elevated tiers only, per that file's finding ② comment).
export default async function AppraisalCyclesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Appraisal Cycles" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  if (!can(me, "appraisal.cycle.admin", tenant)) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Appraisal Cycles" />
        <ReportAccessDenied reason="Cycle administration is an HR / company-admin capability. Your own appraisal is at /appraisals/mine." />
      </>
    );
  }

  try {
    const { cycles } = await getAppraisalCycles(tenant, userId);
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="Appraisal Cycles" subtitle="Open a cycle, generate appraisals against sealed periods, and track it through review." />
        <CycleForm createAction={createAppraisalCycle} />
        {cycles.length === 0 ? (
          <EmptyNote>No appraisal cycles yet.</EmptyNote>
        ) : (
          <div className="rc-appr-cycle-list">
            {cycles.map((c) => (
              <Link key={c.id} href={`/appraisals/cycles/${c.id}`} className="rc-appr-cycle-row" style={{ textDecoration: "none", color: "inherit" }}>
                <div>
                  <div className="rc-appr-cycle-row__name">{c.name}</div>
                  <div className="rc-appr-cycle-row__meta">{c.periodStart} — {c.periodEnd}</div>
                </div>
                <StatusBadge label={c.status} />
              </Link>
            ))}
          </div>
        )}
      </>
    );
  } catch (e) {
    if (isForbidden(e)) {
      return (
        <>
          <PageHeader eyebrow="Appraisals" title="Appraisal Cycles" />
          <ReportAccessDenied reason="Cycle administration is an HR / company-admin capability." />
        </>
      );
    }
    throw e;
  }
}
