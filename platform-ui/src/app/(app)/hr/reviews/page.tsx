import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listReviewCyclesResult } from "@/lib/hr-full-data";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ReviewCycleForm } from "@/components/hr/ReviewForms";
import { createReviewCycle } from "@/lib/hrPolicyActions";

// HR › Reviews — probation and review CYCLES (HR-FULL wave A; the write screens are DW-7f-4).
//
// ⚠ NOT AN APPRAISAL SURFACE. Appraisal content — scores, packs, sealing — is owned by the TR-*
//   reports program and lives at /appraisals, with its own roles and its own rules. This page owns
//   the HR-side question that program does not answer: who is in scope, what the window is, who owes
//   a review, and did it happen. A participant links OUT to its appraisal; it never duplicates one.
//
// Layout: this list creates a cycle; each cycle's own page (/hr/reviews/[cycleId], the link the table
// already carried) edits it and manages its participants. The read is honest (ReadResult): a refused or
// failed read is said in words, and the KPIs show a dash rather than a zero. The create control follows the
// capability mirror (hr.policy.manage); the server still decides.
export default async function HrReviewsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const read = await listReviewCyclesResult(userId, tenant);
  const canManage = can(me, "hr.policy.manage", tenant);

  const cycles = read.kind === "ok" ? read.data : [];
  const open = cycles.filter((c) => c.status === "open");
  const probation = cycles.filter((c) => c.kind === "probation" && c.status !== "closed" && c.status !== "cancelled");
  const outstanding = open.reduce((n, c) => n + (c.participantCount - c.completedCount), 0);
  const ok = read.kind === "ok";

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Open cycles" value={ok ? String(open.length) : "—"} foot={ok ? undefined : "cannot be read"} />
        <KpiTile label="Probation live" value={ok ? String(probation.length) : "—"} foot={ok ? "not yet closed" : "cannot be read"} />
        <KpiTile label="Reviews outstanding" value={ok ? String(outstanding) : "—"} foot={ok ? "across open cycles" : "cannot be read"} />
        <KpiTile label="Cycles on file" value={ok ? String(cycles.length) : "—"} foot={ok ? undefined : "cannot be read"} />
      </div>

      <Card
        title="Review cycles"
        hint="Appraisal content is owned by the reports program — a cycle tracks scope, window and completion, and links out."
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && <ReviewCycleForm tenantId={tenant} action={createReviewCycle} />}
          {read.kind === "forbidden" ? (
            <ReadRefusal inline subject="the review cycles" kind="forbidden" />
          ) : read.kind === "unavailable" ? (
            <ReadRefusal inline subject="The review cycles" kind="unavailable" reason={read.reason} />
          ) : cycles.length === 0 ? (
            <EmptyNote>
              No review cycles yet. A cycle is a cohort plus a window: <em>probation</em> runs per-employee off
              the hire date, <em>periodic</em> is an org-wide wave, and <em>project</em> is an ad-hoc cohort tied
              to a delivery.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Cycle" }, { label: "Kind" }, { label: "Period" }, { label: "Status" },
                { label: "Completion", align: "right" },
              ]}
              rows={cycles.map((c) => [
                <Link key={c.id} href={`/hr/reviews/${c.id}`} style={{ color: "var(--erp-accent)" }}>{c.name}</Link>,
                c.kind,
                `${c.periodStart} → ${c.periodEnd}`,
                <StatusBadge key={`${c.id}-s`} label={c.status} />,
                // A cycle with nobody enrolled is not 100% complete — it is not started. Reporting
                // "0/0" says that; a percentage would round it to a green tick.
                `${c.completedCount}/${c.participantCount}`,
              ])}
            />
          )}
        </div>
      </Card>
    </>
  );
}
