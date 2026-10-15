import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { formatMoney } from "@/lib/hr-full";
import {
  listRequisitionsResult, listEmployeesResult, listApplicationsResult, listCandidatesResult, listPipelineStagesResult,
} from "@/lib/hr-full-data";
import { recruitmentControls } from "@/lib/hrRecruitment";
import { Card, StatusBadge, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { RequisitionActions } from "@/components/hr/RequisitionActions";
import type { PersonOption } from "@/components/hr/RequisitionForm";
import { ApplicationForm } from "@/components/hr/ApplicationForm";
import { updateRequisition, setRequisitionStatus, submitRequisition, createApplication } from "@/lib/hrRecruitmentActions";

type Params = Promise<{ requisitionId: string }>;

// HR › Recruitment › one requisition (DW-7f-2). The list at /hr/recruitment links here.
//
// The backend has no `GET requisitions/:id`. This page reads the requisition list and picks the row out of it,
// so the list's own narrowing applies: a hiring manager or recruiter finds their requisitions here, and a
// requisition that is not in what the server returned reads as "not found" (it may exist and not be theirs).
// The list is capped at 500 rows by the server, so the oldest requisitions of a very large company can fall
// off it; that is a backend limit this page cannot see past.
//
// A refused or failed read is said in words, never an empty page. Controls mirror the server (the manage tier,
// and the hiring-manager arm which the page can see because the requisition names its owners).

const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

export default async function HrRequisitionPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { requisitionId } = await params;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const back = (
    <p style={{ margin: "0 0 14px", font: "400 13px var(--font-body)" }}>
      <Link href="/hr/recruitment" style={{ color: "var(--erp-accent)" }}>← Recruitment</Link>
    </p>
  );

  const reqRead = await listRequisitionsResult(userId, tenant);
  if (reqRead.kind === "forbidden") {
    return <>{back}<ReadRefusal subject="this requisition" kind="forbidden" /></>;
  }
  if (reqRead.kind === "unavailable") {
    return <>{back}<ReadRefusal subject="This requisition" kind="unavailable" reason={reqRead.reason} /></>;
  }
  const requisition = reqRead.data.find((r) => r.id === requisitionId);
  if (!requisition) notFound();

  const ctl = recruitmentControls({
    view: can(me, "hr.recruitment.view", tenant),
    manage: can(me, "hr.recruitment.manage", tenant),
    approve: can(me, "hr.recruitment.approve", tenant),
  });
  // The attribute arm the capability list cannot express, but this page can: the requisition names its owners.
  const owner = !!me.userId && (requisition.hiringManagerUserId === me.userId || requisition.recruiterUserId === me.userId);
  const canUpdate = ctl.update || owner;

  // Applications on this requisition (every status, so a hired or rejected one is still on the page). The candidate
  // pool and the stages are only needed to add a candidate, which is the manage tier's.
  const addable = ctl.manage && (requisition.status === "open" || requisition.status === "on_hold");
  const [employeesRead, appRead, candRead, stagesRead] = await Promise.all([
    ctl.manage ? listEmployeesResult(userId, tenant) : null,
    listApplicationsResult(userId, tenant, { requisitionId }),
    addable ? listCandidatesResult(userId, tenant) : null,
    addable ? listPipelineStagesResult(userId, tenant) : null,
  ]);
  const employees = employeesRead?.kind === "ok" ? employeesRead.data : [];
  const people: PersonOption[] = employees.filter((e) => e.userId).map((e) => ({ userId: e.userId as string, name: e.displayName }));
  const nameOf = (uid: string | null) => (uid ? employees.find((e) => e.userId === uid)?.displayName ?? "assigned" : "—");

  const r = requisition;
  return (
    <>
      {back}

      <Card title={`${r.reference} — ${r.title}`} style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <dl style={{ display: "grid", gap: "8px 24px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", margin: 0, font: "400 13px/1.5 var(--font-body)" }}>
            <Fact label="Status" value={<StatusBadge label={r.status} />} />
            <Fact label="Filled" value={`${r.filled} of ${r.openings}`} />
            <Fact label="Employment" value={r.employmentType} />
            <Fact label="Work mode" value={r.workMode ?? "—"} />
            <Fact label="Location" value={r.location ?? "—"} />
            <Fact label="Target start" value={r.targetStartOn ? r.targetStartOn.slice(0, 10) : "—"} />
            <Fact label="Salary band" value={
              r.salaryMin || r.salaryMax
                ? `${r.salaryMin ? formatMoney(r.salaryMin, r.currency) : "—"} to ${r.salaryMax ? formatMoney(r.salaryMax, r.currency) : "—"}`
                : "—"
            } />
            <Fact label="Hiring manager" value={employeesRead?.kind === "ok" ? nameOf(r.hiringManagerUserId) : r.hiringManagerUserId ? "assigned" : "—"} />
            <Fact label="Recruiter" value={employeesRead?.kind === "ok" ? nameOf(r.recruiterUserId) : r.recruiterUserId ? "assigned" : "—"} />
          </dl>
          <div style={dim}>{r.activeApplications} active application(s). Created {r.createdAt.slice(0, 10)}.</div>
          <RequisitionActions
            tenantId={tenant} requisitionId={r.id} reference={r.reference} status={r.status}
            canManage={ctl.manage} canUpdate={canUpdate} people={people} initial={r}
            api={{ submit: submitRequisition, setStatus: setRequisitionStatus, update: updateRequisition }}
          />
          {ctl.manage && employeesRead && employeesRead.kind !== "ok" ? (
            <ReadRefusal inline subject={employeesRead.kind === "forbidden" ? "the employee list" : "The employee list"} kind={employeesRead.kind}
              reason={employeesRead.kind === "unavailable" ? employeesRead.reason : undefined}
              detail="Hiring managers and recruiters cannot be picked or named without it." />
          ) : null}
        </div>
      </Card>

      <Card title="Applications">
        <div style={{ display: "grid", gap: 14 }}>
          {appRead.kind === "forbidden" ? (
            <ReadRefusal inline subject="the applications on this requisition" kind="forbidden" />
          ) : appRead.kind === "unavailable" ? (
            <ReadRefusal inline subject="The applications on this requisition" kind="unavailable" reason={appRead.reason} />
          ) : appRead.data.length === 0 ? (
            <EmptyNote>No applications on this requisition yet.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Candidate" }, { label: "Stage" }, { label: "Status" },
                { label: "Rating", align: "right" }, { label: "Days in stage", align: "right" },
              ]}
              rows={appRead.data.map((a) => [
                <Link key={a.id} href={`/hr/recruitment/applications/${a.id}`} style={{ color: "var(--erp-accent)" }}>{a.candidateName}</Link>,
                a.stageKey,
                <StatusBadge key={`${a.id}-s`} label={a.status} />,
                a.rating ? Number(a.rating).toFixed(1) : "—",
                String(a.daysInStage),
              ])}
            />
          )}
          {addable && candRead?.kind === "ok" && stagesRead?.kind === "ok" ? (
            <ApplicationForm
              create={createApplication} companyId={tenant} requisitionId={r.id}
              candidates={candRead.data.filter((c) => !c.erasureRequestedAt).map((c) => ({ id: c.id, name: c.fullName, email: c.email }))}
              stages={stagesRead.data.filter((s) => s.isActive && !s.isTerminal).map((s) => ({ key: s.key, label: s.label }))}
            />
          ) : addable && candRead && stagesRead ? (
            <ReadRefusal
              inline subject={candRead.kind !== "ok" ? "the talent pool" : "the pipeline stages"}
              kind={(candRead.kind !== "ok" ? candRead.kind : stagesRead.kind) as "forbidden" | "unavailable"}
              reason={candRead.kind === "unavailable" ? candRead.reason : stagesRead.kind === "unavailable" ? stagesRead.reason : undefined}
              detail="A candidate cannot be added without it."
            />
          ) : ctl.manage && !addable ? (
            <p style={{ margin: 0, ...dim }}>Candidates can be added while the requisition is open or on hold. This one is {r.status.replace("_", " ")}.</p>
          ) : null}
        </div>
      </Card>
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt style={{ ...dim, margin: 0 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
