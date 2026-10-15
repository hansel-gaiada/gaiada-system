import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getApplicationResult, listEmployeesResult, listPipelineStagesResult } from "@/lib/hr-full-data";
import { recruitmentControls, formatInZone } from "@/lib/hrRecruitment";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ApplicationStageMove } from "@/components/hr/ApplicationStageMove";
import { InterviewForm, InterviewEditor } from "@/components/hr/InterviewForm";
import type { PersonOption } from "@/components/hr/RequisitionForm";
import { moveApplicationStage, scheduleInterview, updateInterview } from "@/lib/hrRecruitmentActions";

type Params = Promise<{ applicationId: string }>;

// HR › Recruitment › one application (DW-7f-2). The pipeline and the requisition page link here; so does the
// notification the server sends a panelist.
//
// The server narrows this read to the people attached to the application (HR, the requisition's hiring manager
// and recruiter, and the interview panel). A refused or failed read is said in words, never an empty page, and
// a 404 is a real "no such application" (or not one this viewer can see).
//
// Controls mirror the server. `update` (stage, interviews) also belongs to the hiring manager and recruiter, which
// the capability list cannot express, so someone who reaches the page without any recruitment capability is shown
// them and the server refuses in words. A panelist (visible in the interviews) is shown the scorecard form.

const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;
const MOVABLE = ["active", "on_hold"];

export default async function HrApplicationPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { applicationId } = await params;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const back = (
    <p style={{ margin: "0 0 14px", font: "400 13px var(--font-body)" }}>
      <Link href="/hr/recruitment" style={{ color: "var(--erp-accent)" }}>← Recruitment</Link>
    </p>
  );

  const result = await getApplicationResult(userId, tenant, applicationId);
  if (result.kind === "forbidden") {
    return <>{back}<ReadRefusal subject="this application" kind="forbidden" detail="It is visible to HR, the requisition's hiring manager and recruiter, and the interview panel." /></>;
  }
  if (result.kind === "unavailable") {
    return <>{back}<ReadRefusal subject="This application" kind="unavailable" reason={result.reason} /></>;
  }
  const app = result.data;
  if (!app) notFound();

  const isPanelist = !!me.userId && app.interviews.some((i) => i.panelists.some((p) => p.userId === me.userId));
  const ctl = recruitmentControls({
    view: can(me, "hr.recruitment.view", tenant),
    manage: can(me, "hr.recruitment.manage", tenant),
    approve: can(me, "hr.recruitment.approve", tenant),
  }, isPanelist);

  const [stagesRead, employeesRead] = await Promise.all([
    listPipelineStagesResult(userId, tenant),
    ctl.manage ? listEmployeesResult(userId, tenant) : null,
  ]);
  const employees = employeesRead?.kind === "ok" ? employeesRead.data : [];
  const people: PersonOption[] = employees.filter((e) => e.userId).map((e) => ({ userId: e.userId as string, name: e.displayName }));
  const nameOf = (uid: string | null) => (uid ? employees.find((e) => e.userId === uid)?.displayName ?? "a colleague" : "—");
  const stageLabel = (key: string) =>
    (stagesRead?.kind === "ok" ? stagesRead.data.find((s) => s.key === key)?.label : undefined) ?? key;
  const movable = MOVABLE.includes(app.status);

  return (
    <>
      {back}

      <Card title={`${app.candidateName} — ${app.requisitionReference}`} style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <dl style={{ display: "grid", gap: "8px 24px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", margin: 0, font: "400 13px/1.5 var(--font-body)" }}>
            <Fact label="Requisition" value={<Link href={`/hr/recruitment/${app.requisitionId}`} style={{ color: "var(--erp-accent)" }}>{app.requisitionReference} — {app.requisitionTitle}</Link>} />
            <Fact label="Stage" value={stageLabel(app.stageKey)} />
            <Fact label="Status" value={<StatusBadge label={app.status} />} />
            <Fact label="Rating" value={app.rating ? Number(app.rating).toFixed(1) : "—"} />
            <Fact label="Applied" value={app.appliedOn.slice(0, 10)} />
            <Fact label="Email" value={app.candidateEmail ?? "—"} />
            <Fact label="Phone" value={app.candidatePhone ?? "—"} />
            <Fact label="Headline" value={app.headline ?? "—"} />
          </dl>
          {ctl.update && movable ? (
            stagesRead?.kind === "ok" ? (
              <ApplicationStageMove
                tenantId={tenant} applicationId={app.id} candidateName={app.candidateName} currentStageKey={app.stageKey}
                stages={stagesRead.data.filter((s) => s.isActive)} move={moveApplicationStage}
              />
            ) : stagesRead ? (
              <ReadRefusal inline subject={stagesRead.kind === "forbidden" ? "the pipeline stages" : "The pipeline stages"} kind={stagesRead.kind}
                reason={stagesRead.kind === "unavailable" ? stagesRead.reason : undefined} detail="The application cannot be moved without them." />
            ) : null
          ) : ctl.update ? (
            <p style={{ margin: 0, ...dim }}>This application is {app.status}, so it can no longer be moved.</p>
          ) : null}
        </div>
      </Card>

      <Card title="Interviews" style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gap: 14 }}>
          {app.interviews.length === 0 ? (
            <EmptyNote>No interviews scheduled.</EmptyNote>
          ) : (
            app.interviews.map((i) => (
              <section key={i.id} aria-label={`${i.kind} interview`} style={{ display: "grid", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--erp-line)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", font: "400 13px/1.5 var(--font-body)" }}>
                  <strong>{i.kind}</strong>
                  <StatusBadge label={i.status} />
                  {i.outcome ? <span>outcome: {i.outcome}</span> : null}
                </div>
                <div style={{ font: "400 13px/1.5 var(--font-body)" }}>
                  {formatInZone(i.scheduledStart, i.timezone)} to {formatInZone(i.scheduledEnd, i.timezone)} ({i.timezone})
                </div>
                {(i.location || i.meetingUrl) && (
                  <div style={dim}>
                    {i.location ?? ""}{i.location && i.meetingUrl ? " · " : ""}
                    {i.meetingUrl ? <a href={i.meetingUrl} rel="noreferrer noopener" style={{ color: "var(--erp-accent)" }}>Meeting link</a> : null}
                  </div>
                )}
                <div style={dim}>
                  Panel: {i.panelists.length === 0 ? "none named" : i.panelists.map((p) => `${nameOf(p.userId)} (${p.role}, ${p.response})`).join("; ")}
                </div>
                {ctl.update && <InterviewEditor update={updateInterview} tenantId={tenant} applicationId={app.id} interview={i} />}
              </section>
            ))
          )}
          {ctl.update && (
            <InterviewForm schedule={scheduleInterview} tenantId={tenant} applicationId={app.id} people={people} />
          )}
          {ctl.manage && employeesRead && employeesRead.kind !== "ok" ? (
            <ReadRefusal inline subject={employeesRead.kind === "forbidden" ? "the employee list" : "The employee list"} kind={employeesRead.kind}
              reason={employeesRead.kind === "unavailable" ? employeesRead.reason : undefined}
              detail="Panelists cannot be picked or named without it." />
          ) : null}
        </div>
      </Card>

      <Card title="Timeline">
        {app.events.length === 0 ? (
          <EmptyNote>No events recorded.</EmptyNote>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, font: "400 13px/1.5 var(--font-body)" }}>
            {app.events.map((e, idx) => (
              <li key={idx}>
                <strong>{e.eventType.replace(/_/g, " ")}</strong>
                {e.fromStageKey || e.toStageKey ? <> {stageLabel(e.fromStageKey ?? "—")} → {stageLabel(e.toStageKey ?? "—")}</> : null}
                {e.body ? <>: {e.body}</> : null}
                <span style={dim}> · {e.occurredAt.slice(0, 10)}</span>
              </li>
            ))}
          </ol>
        )}
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
