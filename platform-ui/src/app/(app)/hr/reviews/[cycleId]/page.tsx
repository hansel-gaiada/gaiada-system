import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listReviewCyclesResult, listReviewParticipantsResult, listEmployeesResult } from "@/lib/hr-full-data";
import { PICKABLE_EMPLOYEE_STATUSES, label } from "@/lib/hrPolicy";
import type { ReadResult } from "@/lib/readResult";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ReviewCycleEditForm, ParticipantsAddForm, ParticipantUpdateForm } from "@/components/hr/ReviewForms";
import { updateReviewCycle, addReviewParticipants, updateReviewParticipant } from "@/lib/hrPolicyActions";

type Params = Promise<{ cycleId: string }>;

// HR › Reviews › one cycle (DW-7f-4). The list at /hr/reviews links here.
//
// NOT AN APPRAISAL SURFACE: a participant's `appraisalId` links OUT to the reports program, which owns scores, packs
// and sealing. This page records who is in scope, who reviews them, where each review stands and the HR verdict.
//
// What this page holds:
//   - There is no single-cycle read on the server; the cycle is found in the list. A list that read fine but does not
//     hold the id is a real "no such cycle" (404); a refused or failed list is said in words.
//   - Participants are an honest read: a refusal is never shown as "nobody enrolled".
//   - Controls follow the capability mirror (hr.policy.manage shows edit, add and update); the server still decides.
//     Participants and reviewers are USER ids, so employees without a login account cannot be picked, and the form
//     says how many were left out.
//   - Status: the server has no status machine, so the edit form offers every status.
const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

function Refused<T>({ read, subject }: { read: Exclude<ReadResult<T>, { kind: "ok" }>; subject: string }) {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return read.kind === "forbidden"
    ? <ReadRefusal inline subject={subject} kind="forbidden" />
    : <ReadRefusal inline subject={Subject} kind="unavailable" reason={read.reason} />;
}

export default async function HrReviewCyclePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { cycleId } = await params;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const back = (
    <p style={{ margin: "0 0 14px", font: "400 13px var(--font-body)" }}>
      <Link href="/hr/reviews" style={{ color: "var(--erp-accent)" }}>← All review cycles</Link>
    </p>
  );

  const canManage = can(me, "hr.policy.manage", tenant);
  const [cyclesRead, participantsRead, employeesRead] = await Promise.all([
    listReviewCyclesResult(userId, tenant),
    listReviewParticipantsResult(userId, tenant, cycleId),
    listEmployeesResult(userId, tenant),
  ]);

  if (cyclesRead.kind !== "ok") {
    return <>{back}<Refused read={cyclesRead} subject="this review cycle" /></>;
  }
  const cycle = cyclesRead.data.find((c) => c.id === cycleId);
  if (!cycle) notFound();

  const participants = participantsRead.kind === "ok" ? participantsRead.data : [];

  // Employees are USER-keyed for reviews. `userId` is null for someone with no login account.
  const employees = employeesRead.kind === "ok" ? employeesRead.data : [];
  const pickable = employees.filter((e) => PICKABLE_EMPLOYEE_STATUSES.includes(e.employmentStatus));
  const withLogin = pickable.filter((e) => e.userId);
  const nameOf = new Map(employees.filter((e) => e.userId).map((e) => [e.userId as string, e.displayName]));
  const reviewerOptions = withLogin.map((e) => ({ value: e.userId as string, label: e.displayName }));
  const enrolled = new Set(participants.map((p) => p.subjectUserId));
  const addable = reviewerOptions.filter((o) => !enrolled.has(o.value));
  const reviewerName = (id: string | null) =>
    id === null ? "Unassigned" : nameOf.get(id) ?? "Assigned (name not shown)";

  const needsEmployees = (children: React.ReactNode) =>
    employeesRead.kind === "ok" ? children : <Refused read={employeesRead} subject="the employee list" />;

  const done = participants.filter((p) => ["submitted", "acknowledged", "waived"].includes(p.status)).length;

  return (
    <>
      {back}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Status" value={cycle.status} foot={cycle.kind} />
        <KpiTile label="Period" value={cycle.periodStart} foot={`to ${cycle.periodEnd}`} />
        <KpiTile label="Window" value={cycle.opensOn ?? "—"} foot={cycle.closesOn ? `closes ${cycle.closesOn}` : "no closing date"} />
        <KpiTile
          label="Completed"
          value={participantsRead.kind === "ok" ? `${done}/${participants.length}` : `${cycle.completedCount}/${cycle.participantCount}`}
          foot={participantsRead.kind === "ok" ? "submitted, acknowledged or waived" : "from the cycle list"}
        />
      </div>

      <Card
        title={cycle.name}
        hint="The period and the kind are fixed at creation; the name, status and completion window can change."
        style={{ marginBottom: 22 }}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
            <StatusBadge label={cycle.status} /> {cycle.kind} · {cycle.periodStart} → {cycle.periodEnd}
          </p>
          {canManage && (
            <ReviewCycleEditForm
              tenantId={tenant} cycleId={cycle.id} action={updateReviewCycle}
              initial={{ name: cycle.name, status: cycle.status, opensOn: cycle.opensOn, closesOn: cycle.closesOn }}
            />
          )}
        </div>
      </Card>

      <Card
        title="Participants"
        hint="Who is reviewed, by whom, and where each review stands. A participant's appraisal itself lives in the reports program."
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && needsEmployees(
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <ParticipantsAddForm
                tenantId={tenant} cycleId={cycle.id} action={addReviewParticipants}
                people={addable} reviewers={reviewerOptions} excluded={pickable.length - withLogin.length}
              />
              {participantsRead.kind === "ok" && participants.length > 0 && (
                <ParticipantUpdateForm
                  tenantId={tenant} action={updateReviewParticipant} reviewers={reviewerOptions}
                  showOutcome={cycle.kind === "probation"}
                  participants={participants.map((p) => ({
                    value: p.id, label: `${p.subjectName ?? "Unnamed"} (${label(p.status)})`,
                  }))}
                />
              )}
            </div>,
          )}
          {participantsRead.kind !== "ok" ? (
            <Refused read={participantsRead} subject="the participants" />
          ) : participants.length === 0 ? (
            <EmptyNote>
              Nobody is enrolled in this cycle yet. An unassigned reviewer is shown as such rather than guessed
              from the org chart.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Person" }, { label: "Reviewer" }, { label: "Due" }, { label: "Status" },
                { label: "Outcome" }, { label: "Appraisal" },
              ]}
              rows={participants.map((p) => [
                p.subjectName ?? "Unnamed",
                reviewerName(p.reviewerUserId),
                p.dueOn ?? "—",
                <StatusBadge key={p.id} label={p.status} />,
                p.outcome ? `${p.outcome}${p.outcomeNote ? ` — ${p.outcomeNote}` : ""}` : "—",
                p.appraisalId
                  ? <Link key={`${p.id}-a`} href={`/appraisals/${p.appraisalId}`} style={{ color: "var(--erp-accent)" }}>Open</Link>
                  : "—",
              ])}
            />
          )}
          <p role="note" style={{ margin: 0, ...dim }}>
            Linking a participant to an appraisal is done in the reports program; this page only shows the link.
          </p>
        </div>
      </Card>
    </>
  );
}
