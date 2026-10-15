import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { formatMoney } from "@/lib/hr-full";
import {
  listRequisitionsResult, listApplicationsResult, listCandidatesResult, getFunnelResult, listEmployeesResult,
} from "@/lib/hr-full-data";
import { recruitmentControls } from "@/lib/hrRecruitment";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { RequisitionForm, type PersonOption } from "@/components/hr/RequisitionForm";
import { RequisitionActions } from "@/components/hr/RequisitionActions";
import { CandidateForm } from "@/components/hr/CandidateForm";
import { CandidateErasureButton } from "@/components/hr/CandidateErasureButton";
import {
  createRequisition, updateRequisition, setRequisitionStatus, submitRequisition, createCandidate, requestCandidateErasure,
} from "@/lib/hrRecruitmentActions";

// HR › Recruitment — the ATS console (HR-FULL wave B; the write screens are DW-7f-2).
//
// One page rather than four because the funnel IS the object of attention: a recruiter's question is
// "where is everybody stuck", and splitting requisitions / candidates / applications across tabs
// answers it only after three clicks. A requisition's page (/hr/recruitment/[requisitionId]) and an
// application's page (/hr/recruitment/applications/[applicationId]) are the drill-downs.
//
// Scope note: an ordinary staff member who is a hiring manager or on an interview panel reaches this
// page too, and the BACKEND narrows what they see to their own pipeline (the panel arm in
// resource_hr_recruitment.yaml, plus the matching WHERE clause in recruitment.controller.ts). The UI
// does not attempt to re-derive that narrowing — it renders what it is given, which is the only way
// the two cannot disagree.
//
// Reads are honest (ReadResult): a refused or failed read is said in words, never an empty table that
// could mean "nothing here". Controls mirror the server (hr.recruitment.manage; the hiring-manager and
// panel arms cannot be expressed here, so those controls are shown and the server refuses in words).
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
  const ctl = recruitmentControls({
    view: can(me, "hr.recruitment.view", tenant),
    manage: can(me, "hr.recruitment.manage", tenant),
    approve: can(me, "hr.recruitment.approve", tenant),
  });
  const [reqRead, appRead, candRead, funnelRead, employeesRead] = await Promise.all([
    listRequisitionsResult(userId, tenant),
    listApplicationsResult(userId, tenant, { requisitionId, status: "active" }),
    listCandidatesResult(userId, tenant),
    getFunnelResult(userId, tenant, requisitionId),
    ctl.manage ? listEmployeesResult(userId, tenant) : null,
  ]);

  const requisitions = reqRead.kind === "ok" ? reqRead.data : [];
  const applications = appRead.kind === "ok" ? appRead.data : [];
  const candidates = candRead.kind === "ok" ? candRead.data : [];
  const people: PersonOption[] = employeesRead?.kind === "ok"
    ? employeesRead.data.filter((e) => e.userId).map((e) => ({ userId: e.userId as string, name: e.displayName }))
    : [];

  const openRequisitions = requisitions.filter((r) => r.status === "open");
  const openings = openRequisitions.reduce((n, r) => n + (r.openings - r.filled), 0);
  // Applications sitting in one stage longest — the recruiter's actual working list, and the reason
  // `stage_entered_at` is reset on every move rather than derived from the event log.
  const stalled = [...applications].sort((a, b) => b.daysInStage - a.daysInStage).slice(0, 8);
  const defaultCurrency = requisitions[0]?.currency ?? "IDR";

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Open requisitions" value={reqRead.kind === "ok" ? String(openRequisitions.length) : "—"}
          foot={reqRead.kind === "ok" ? `${openings} seat(s) unfilled` : "could not be read"} />
        <KpiTile label="Active applications" value={appRead.kind === "ok" ? String(applications.length) : "—"} />
        <KpiTile label="Talent pool" value={candRead.kind === "ok" ? String(candidates.length) : "—"}
          foot={candRead.kind === "ok" ? "candidates on file" : "could not be read"} />
        <KpiTile
          label="Longest in stage"
          value={stalled[0] ? `${stalled[0].daysInStage}d` : "—"}
          foot={stalled[0]?.candidateName ?? (appRead.kind === "ok" ? "nothing stalled" : "could not be read")}
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
        {funnelRead.kind === "forbidden" ? (
          <ReadRefusal inline subject="the recruitment funnel" kind="forbidden" />
        ) : funnelRead.kind === "unavailable" ? (
          <ReadRefusal inline subject="The recruitment funnel" kind="unavailable" reason={funnelRead.reason} />
        ) : funnelRead.data.length === 0 ? (
          <EmptyNote>
            No pipeline stages are configured yet. HR defines the funnel on{" "}
            <Link href="/hr/settings" style={{ color: "var(--erp-accent)" }}>HR settings</Link> — stages are data, so
            every company can run the funnel it actually runs.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Stage" }, { label: "In stage", align: "right" }, { label: "Median days", align: "right" }]}
            rows={funnelRead.data.map((f) => [
              f.label,
              String(f.count),
              // A stage with nobody in it has no median. Rendering 0.00 there would read as "fast".
              f.count === 0 ? "—" : Number(f.medianDaysInStage).toFixed(1),
            ])}
          />
        )}
      </Card>

      <Card title="Requisitions" style={{ marginBottom: 22 }}>
        {ctl.manage && (
          <RequisitionForm create={createRequisition} companyId={tenant} defaultCurrency={defaultCurrency} people={people} />
        )}
        {reqRead.kind === "forbidden" ? (
          <ReadRefusal inline subject="the requisitions" kind="forbidden"
            detail="A hiring manager or recruiter sees the requisitions they own, and HR sees all of them." />
        ) : reqRead.kind === "unavailable" ? (
          <ReadRefusal inline subject="The requisitions" kind="unavailable" reason={reqRead.reason} />
        ) : requisitions.length === 0 ? (
          <EmptyNote>
            No requisitions yet.{ctl.manage ? " Raise one to start a pipeline — it needs approval before it opens." : ""}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Reference" }, { label: "Title" }, { label: "Status" },
              { label: "Filled", align: "right" }, { label: "Band", align: "right" }, { label: "Active", align: "right" },
              { label: "" },
            ]}
            rows={requisitions.map((r) => [
              <Link key={r.id} href={`/hr/recruitment/${r.id}`} style={{ color: "var(--erp-accent)" }}>
                {r.reference}
              </Link>,
              r.title,
              <StatusBadge key={`${r.id}-s`} label={r.status} />,
              `${r.filled}/${r.openings}`,
              // The approved envelope. Shown because an offer above it is refused by the backend, and
              // seeing the ceiling before drafting is cheaper than being told after.
              r.salaryMax ? `up to ${formatMoney(r.salaryMax, r.currency)}` : "—",
              String(r.activeApplications),
              // A draft's one next step. Editing, holding and closing are on the requisition's page.
              r.status === "draft" && ctl.manage ? (
                <RequisitionActions
                  key={`${r.id}-a`} compact tenantId={tenant} requisitionId={r.id} reference={r.reference} status={r.status}
                  canManage={ctl.manage} canUpdate={ctl.update} people={people} initial={r}
                  api={{ submit: submitRequisition, setStatus: setRequisitionStatus, update: updateRequisition }}
                />
              ) : (
                <Link key={`${r.id}-l`} href={`/hr/recruitment/${r.id}`} style={{ color: "var(--erp-accent)" }}>Open</Link>
              ),
            ])}
          />
        )}
      </Card>

      <Card title={requisitionId ? "Applications in this pipeline" : "Applications needing attention"} style={{ marginBottom: 22 }}>
        {appRead.kind === "forbidden" ? (
          <ReadRefusal inline subject="the applications" kind="forbidden" />
        ) : appRead.kind === "unavailable" ? (
          <ReadRefusal inline subject="The applications" kind="unavailable" reason={appRead.reason} />
        ) : stalled.length === 0 ? (
          <EmptyNote>No active applications.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Candidate" }, { label: "Requisition" }, { label: "Stage" },
              { label: "Rating", align: "right" }, { label: "Days in stage", align: "right" },
            ]}
            rows={stalled.map((a) => [
              <Link key={a.id} href={`/hr/recruitment/applications/${a.id}`} style={{ color: "var(--erp-accent)" }}>
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

      <Card title="Talent pool">
        {ctl.manage && <CandidateForm create={createCandidate} companyId={tenant} />}
        {candRead.kind === "forbidden" ? (
          <ReadRefusal inline subject="the talent pool" kind="forbidden" />
        ) : candRead.kind === "unavailable" ? (
          <ReadRefusal inline subject="The talent pool" kind="unavailable" reason={candRead.reason} />
        ) : candidates.length === 0 ? (
          <EmptyNote>No candidates on file.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Candidate" }, { label: "Contact" }, { label: "Source" },
              { label: "Applications", align: "right" }, { label: "Data" },
            ]}
            rows={candidates.map((c) => [
              <span key={c.id}>
                {c.fullName}
                {c.headline ? <span style={{ display: "block", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>{c.headline}</span> : null}
              </span>,
              c.email ?? c.phone ?? "—",
              c.source,
              String(c.applicationCount),
              c.erasureRequestedAt ? (
                <span key={`${c.id}-e`}>Erasure requested {c.erasureRequestedAt.slice(0, 10)}</span>
              ) : ctl.manage ? (
                <CandidateErasureButton key={`${c.id}-x`} tenantId={tenant} candidateId={c.id} name={c.fullName} erase={requestCandidateErasure} />
              ) : (
                c.retentionUntil ? `keep until ${c.retentionUntil.slice(0, 10)}` : "—"
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
