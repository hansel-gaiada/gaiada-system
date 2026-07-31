import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getMyAppraisals } from "@/lib/appraisals-data";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { StatusBadge } from "@/components/ui";
import { AppraisalPackView } from "@/components/reports/appraisals/AppraisalPackView";
import { AckDisputeForm } from "@/components/reports/appraisals/AckDisputeForm";
import { ackAppraisal } from "@/lib/appraisalActions";

// TR-26 — `/appraisals/mine` (§6.2 `GET /appraisals/mine`, self-service, no capability gate — same
// reasoning as `/checkins/today`: every principal reads their own record, always). §11 principle 2:
// this renders EXACTLY the same `AppraisalPack` shape the manager scored — `AppraisalPackView` below
// is the identical component the manager's read-only view uses, with only the ack/dispute form
// added underneath as this page's `footerSlot`.
export default async function MyAppraisalsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title="My Appraisals" />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const { appraisals } = await getMyAppraisals(tenant, userId);

  return (
    <>
      <PageHeader
        eyebrow="Appraisals"
        title="My Appraisals"
        subtitle="What was said about you, exactly as your manager submitted it — nothing added, nothing withheld."
      />
      {appraisals.length === 0 ? (
        <EmptyNote>No appraisal has been submitted to you yet.</EmptyNote>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {appraisals.map((pack) => (
            <div key={pack.id} style={{ border: "0.5px solid var(--erp-hairline)" }}>
              <div style={{ padding: "14px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ font: "700 12px var(--font-body)", color: "var(--erp-ink-50)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {pack.cycleName}
                </span>
                <StatusBadge label={pack.status} />
              </div>
              <AppraisalPackView
                pack={pack}
                footerSlot={pack.status !== "finalized" ? <AckDisputeForm appraisalId={pack.id} ackAction={ackAppraisal} /> : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
