import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getMyLearning, completionPct, dueState, fmtDate, type MyEnrollment } from "@/lib/lms";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";

// /me › Learning — the employee's OWN assigned training.
//
// Passes NO subject: it asks the backend for "mine" and the backend decides what that means. That
// is the only arrangement in which this page and resource_lms_enrollment.yaml's member arm cannot
// disagree — the same shape /me/pay uses for payslips.
//
// ⚠ THIS PAGE DOES NOT DEGRADE ON ERROR. `getMyLearning` rethrows rather than returning an empty
//   object, because "you have no training assigned" is the single most consequential wrong answer
//   this surface can give: somebody skips mandatory training because the page told them there was
//   none. An error boundary showing a failure is strictly better than a confident empty state.
export default async function MyLearningPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // Checked BEFORE the read, not after it. `getMyLearning` deliberately rethrows rather than
  // degrading, so without this gate an employee at a company without the LMS would get an error
  // boundary. A module that is switched off is a known, explainable state — not a failure.
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  const { enrolments, certifications } = await getMyLearning(userId, tenant);

  const outstanding = enrolments.filter((e) => e.status === "assigned" || e.status === "in_progress");
  const mandatoryOutstanding = outstanding.filter((e) => e.isMandatory);
  const overdue = outstanding.filter((e) => e.overdue);
  const done = enrolments.filter((e) => e.status === "completed");

  const row = (e: MyEnrollment) => {
    const pct = completionPct(e.coursesCompleted, e.coursesRequired);
    const due = dueState(e.dueOn, e.status);
    return [
      <span key={`${e.id}-t`}>
        <Link href={`/learning/paths/${e.pathId}`} style={{ color: "var(--erp-accent)" }}>{e.title}</Link>
        {e.isMandatory && (
          <span style={{ marginLeft: 8, font: "500 11px var(--font-body)", color: "var(--status-warning-fg)" }}>
            REQUIRED
          </span>
        )}
      </span>,
      <StatusBadge key={`${e.id}-s`} label={e.status} />,
      // NULL means the path has no required courses — misconfigured, not complete. Rendering it as
      // 100% would tell somebody they had passed training that does not exist.
      pct === null ? "—" : `${e.coursesCompleted}/${e.coursesRequired} · ${pct}%`,
      <span key={`${e.id}-d`} style={{ color: due === "overdue" ? "var(--status-danger-fg)" : undefined }}>
        {fmtDate(e.dueOn)}{due === "overdue" ? " (overdue)" : due === "due-soon" ? " (soon)" : ""}
      </span>,
    ];
  };

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Outstanding" value={String(outstanding.length)} foot="assigned or in progress" />
        <KpiTile
          label="Required"
          value={String(mandatoryOutstanding.length)}
          foot={mandatoryOutstanding.length ? "must be completed" : "all clear"}
        />
        <KpiTile label="Overdue" value={String(overdue.length)} />
        <KpiTile label="Certificates" value={String(certifications.length)} foot="earned" />
      </div>

      {mandatoryOutstanding.length > 0 && (
        <div
          role="note"
          style={{
            marginBottom: 22, padding: "12px 16px", borderRadius: 10,
            border: "1px solid var(--status-warning)",
            background: "var(--status-warning-bg)",
            font: "400 13px/1.6 var(--font-body)",
          }}
        >
          You have <strong>{mandatoryOutstanding.length}</strong> required course
          {mandatoryOutstanding.length === 1 ? "" : "s"} outstanding
          {overdue.length > 0 ? <>, <strong>{overdue.length}</strong> of them overdue</> : null}.
        </div>
      )}

      <Card title="Assigned to me" style={{ marginBottom: 22 }}>
        {outstanding.length === 0 ? (
          <EmptyNote>
            Nothing outstanding. Required training is assigned automatically — if you are expecting
            something and it is not here, it has not been assigned yet rather than been missed.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Path" }, { label: "Status" }, { label: "Progress", align: "right" }, { label: "Due" }]}
            rows={outstanding.map(row)}
          />
        )}
      </Card>

      {done.length > 0 && (
        <Card title="Completed" style={{ marginBottom: 22 }}>
          <HairlineTable
            columns={[{ label: "Path" }, { label: "Status" }, { label: "Progress", align: "right" }, { label: "Due" }]}
            rows={done.map(row)}
          />
        </Card>
      )}

      <Card
        title="My certificates"
        hint="A certificate is recorded on your HR file, so its expiry flows through the same compliance sweep as your contracts and permits."
      >
        {certifications.length === 0 ? (
          <EmptyNote>No certificates yet. Completing a full learning path earns one.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Certificate" }, { label: "Earned" }, { label: "Expires" }, { label: "Score", align: "right" }]}
            rows={certifications.map((c) => [
              c.pathKey,
              c.completedAt.slice(0, 10),
              // No expiry is a real state (a one-off induction), not a missing value.
              c.expiresOn ?? "does not expire",
              c.finalScore ? `${Number(c.finalScore).toFixed(0)}%` : "—",
            ])}
          />
        )}
      </Card>

      <p style={{ margin: "18px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
        Browse everything on offer in the{" "}
        <Link href="/learning/catalogue" style={{ color: "var(--erp-accent)" }}>learning catalogue</Link>.
      </p>
    </>
  );
}
