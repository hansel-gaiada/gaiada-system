import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getCompliance, type ComplianceRow } from "@/lib/lms";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import { isModuleOnForActiveCompany } from "@/lib/modules";

// Learning › Compliance — has everyone completed what they must?
//
// Aggregate BY PATH, never a per-person score dump. That distinction is deliberate: a compliance
// view should answer "are we covered" without spreading everybody's scores — failed attempts
// included — across a dashboard half the company can open. The per-person register is the EXPORT,
// and that sits behind `lms.enrollment.export` at the high-assurance tier.
export default async function LearningCompliancePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // The `lms` module answers 403/404 on every route while it is dark, and `soft()` turns that into
  // an empty list — which renders as "nothing is published" rather than "this is switched off".
  // Ask the gate first so the two never look alike.
  if (!(await isModuleOnForActiveCompany("lms"))) return <ModuleDisabled module="lms" label="Learning" />;

  // Fail closed HERE rather than rendering empty cards off a backend that returns nothing — "you
  // may not see this" and "nobody has any training" are different answers and must not look alike.
  if (!can(me, "lms.progress.view", tenant)) {
    return (
      <EmptyNote>
        Training compliance is restricted to HR, department heads and company administrators. Your
        own assigned learning is on <strong>/me/learning</strong>.
      </EmptyNote>
    );
  }

  const rows = await getCompliance(userId, tenant);
  const mandatory = rows.filter((r) => r.isMandatory);

  const totalOutstanding = mandatory.reduce((n, r) => n + r.outstanding, 0);
  const totalOverdue = mandatory.reduce((n, r) => n + r.overdue, 0);
  const totalAssigned = mandatory.reduce((n, r) => n + r.assigned, 0);
  const totalCompleted = mandatory.reduce((n, r) => n + r.completed, 0);
  // Dash rather than 100% when nothing is assigned. "Nothing to comply with" and "fully compliant"
  // are different findings, and reporting the second for the first is a confident wrong number —
  // the same rule completionPct() follows in lib/lms.ts.
  const coverage = totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : null;

  const table = (data: ComplianceRow[]) => (
    <HairlineTable
      columns={[
        { label: "Path" },
        { label: "Assigned", align: "right" },
        { label: "Completed", align: "right" },
        { label: "Outstanding", align: "right" },
        { label: "Overdue", align: "right" },
        { label: "Waived", align: "right" },
      ]}
      rows={data.map((r) => [
        <span key={r.pathKey}>
          {r.title}
          {r.isMandatory && (
            <span className="type-eyebrow" style={{ marginLeft: 8, fontSize: 10 }}>
              required
            </span>
          )}
        </span>,
        String(r.assigned),
        String(r.completed),
        String(r.outstanding),
        <span key={`${r.pathKey}-overdue`} style={{ color: r.overdue > 0 ? "var(--status-danger-fg)" : undefined }}>
          {r.overdue}
        </span>,
        // A waiver is not a completion. Its own column so "covered" is never inflated by the people
        // who were excused from the thing rather than having passed it.
        String(r.waived),
      ])}
    />
  );

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Mandatory coverage"
          value={coverage === null ? "—" : `${coverage}%`}
          foot={coverage === null ? "nothing assigned yet" : `${totalCompleted} of ${totalAssigned} completed`}
          hint="Completions divided by enrolments on MANDATORY paths only. Shown as a dash — not 100% — when nobody is enrolled, because having nothing assigned is not the same as being covered."
        />
        <KpiTile label="Outstanding" value={String(totalOutstanding)} foot="on required paths" />
        <KpiTile label="Overdue" value={String(totalOverdue)} foot="past their due date" />
        <KpiTile label="Paths tracked" value={String(rows.length)} foot={`${mandatory.length} required`} />
      </div>

      <Card
        title="Required training"
        hint="Waivers are counted apart from completions — being excused is not the same as having passed."
        style={{ marginBottom: 22 }}
      >
        {mandatory.length === 0 ? (
          <EmptyNote>
            No mandatory paths are published. The general track — ERP usage, Claude usage, the
            fundamentals every employee takes — is what makes a path mandatory; until one is
            published and marked mandatory, nothing is required of anybody.
          </EmptyNote>
        ) : (
          <>
            {table(mandatory)}
            {totalAssigned === 0 && (
              <p style={{ margin: "12px 0 0", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
                These paths are mandatory but <strong>nobody is enrolled</strong>. Publishing a path
                does not assign it — enrolment is a separate step, so this reads as 0% covered rather
                than as compliant.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="All published paths" hint="Optional paths included, so a department head can see uptake as well as compliance.">
        {rows.length === 0 ? (
          <EmptyNote>No published learning paths in this company yet.</EmptyNote>
        ) : (
          table(rows)
        )}
      </Card>
    </>
  );
}
