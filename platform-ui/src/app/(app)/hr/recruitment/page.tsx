import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listRequisitions, listApplications, listCandidates, getFunnel, formatMoney } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Recruitment — the ATS console (HR-FULL wave B).
//
// One page rather than four because the funnel IS the object of attention: a recruiter's question is
// "where is everybody stuck", and splitting requisitions / candidates / applications across tabs
// answers it only after three clicks. The per-application workspace is the drill-down.
//
// Scope note: an ordinary staff member who is a hiring manager or on an interview panel reaches this
// page too, and the BACKEND narrows what they see to their own pipeline (the panel arm in
// resource_hr_recruitment.yaml, plus the matching WHERE clause in recruitment.controller.ts). The UI
// does not attempt to re-derive that narrowing — it renders what it is given, which is the only way
// the two cannot disagree.
export default async function HrRecruitmentPage({
  searchParams,
}: {
  searchParams: Promise<{ requisitionId?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const { requisitionId } = await searchParams;
  const [requisitions, applications, candidates, funnel] = await Promise.all([
    listRequisitions(userId, tenant),
    listApplications(userId, tenant, { requisitionId, status: "active" }),
    listCandidates(userId, tenant),
    getFunnel(userId, tenant, requisitionId),
  ]);

  const canManage = can(me, "hr.recruitment.manage", tenant);
  const openRequisitions = requisitions.filter((r) => r.status === "open");
  const openings = openRequisitions.reduce((n, r) => n + (r.openings - r.filled), 0);
  // Applications sitting in one stage longest — the recruiter's actual working list, and the reason
  // `stage_entered_at` is reset on every move rather than derived from the event log.
  const stalled = [...applications].sort((a, b) => b.daysInStage - a.daysInStage).slice(0, 8);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Open requisitions" value={String(openRequisitions.length)} foot={`${openings} seat(s) unfilled`} />
        <KpiTile label="Active applications" value={String(applications.length)} />
        <KpiTile label="Talent pool" value={String(candidates.length)} foot="candidates on file" />
        <KpiTile
          label="Longest in stage"
          value={stalled[0] ? `${stalled[0].daysInStage}d` : "—"}
          foot={stalled[0]?.candidateName ?? "nothing stalled"}
        />
      </div>

      <Card
        title={requisitionId ? "Funnel — this requisition" : "Funnel — all open pipelines"}
        headerRight={
          requisitionId
            ? <Link href="/hr/recruitment" className="lux-btn lux-btn--ghost lux-btn--sm">Clear filter</Link>
            : undefined
        }
        style={{ marginBottom: 22 }}
      >
        {funnel.length === 0 ? (
          <EmptyNote>
            No pipeline stages are configured yet. HR defines the funnel on{" "}
            <Link href="/hr/settings" style={{ color: "var(--erp-accent)" }}>HR settings</Link> — stages are data, so
            every company can run the funnel it actually runs.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Stage" }, { label: "In stage", align: "right" }, { label: "Median days", align: "right" }]}
            rows={funnel.map((f) => [
              f.label,
              String(f.count),
              // A stage with nobody in it has no median. Rendering 0.00 there would read as "fast".
              f.count === 0 ? "—" : Number(f.medianDaysInStage).toFixed(1),
            ])}
          />
        )}
      </Card>

      <Card title="Requisitions" style={{ marginBottom: 22 }}>
        {requisitions.length === 0 ? (
          <EmptyNote>
            No requisitions yet.{canManage ? " Raise one to start a pipeline — it needs approval before it opens." : ""}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Reference" }, { label: "Title" }, { label: "Status" },
              { label: "Filled", align: "right" }, { label: "Band", align: "right" }, { label: "Active", align: "right" },
            ]}
            rows={requisitions.map((r) => [
              <Link key={r.id} href={`/hr/recruitment?requisitionId=${r.id}`} style={{ color: "var(--erp-accent)" }}>
                {r.reference}
              </Link>,
              r.title,
              <StatusBadge key={`${r.id}-s`} label={r.status} />,
              `${r.filled}/${r.openings}`,
              // The approved envelope. Shown because an offer above it is refused by the backend, and
              // seeing the ceiling before drafting is cheaper than being told after.
              r.salaryMax ? `up to ${formatMoney(r.salaryMax, r.currency)}` : "—",
              String(r.activeApplications),
            ])}
          />
        )}
      </Card>

      <Card title={requisitionId ? "Applications in this pipeline" : "Applications needing attention"}>
        {stalled.length === 0 ? (
          <EmptyNote>No active applications.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Candidate" }, { label: "Requisition" }, { label: "Stage" },
              { label: "Rating", align: "right" }, { label: "Days in stage", align: "right" },
            ]}
            rows={stalled.map((a) => [
              <Link key={a.id} href={`/hr/recruitment/${a.id}`} style={{ color: "var(--erp-accent)" }}>
                {a.candidateName}
              </Link>,
              a.requisitionReference,
              a.stageKey,
              // A rating only exists once somebody has filed a scorecard; "—" says that, "0.00" lies.
              a.rating ? Number(a.rating).toFixed(1) : "—",
              String(a.daysInStage),
            ])}
          />
        )}
      </Card>
    </>
  );
}
