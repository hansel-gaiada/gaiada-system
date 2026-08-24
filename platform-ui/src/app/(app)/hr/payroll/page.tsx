import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listPayrollRuns, listParameterSets, listSeparations, formatMoney } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Payroll — runs, and the statutory gate that governs them (HR-FULL wave D).
//
// ⚠ THE BANNER AT THE TOP OF THIS PAGE IS THE POINT OF THE PAGE. Every regulated number the engine
//   uses lives in an effective-dated parameter set carrying a `ratified_by` signature that is NULL
//   until an owner signs it off, and a run finalized against an unratified set records a permanent
//   override. Somebody looking at a payroll total needs to know which of those two worlds they are
//   in BEFORE they read the total — not after they have approved it. So the banner renders above
//   the figures, unconditionally, and says which.
export default async function HrPayrollPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // Payroll is the one HR surface hr_staff cannot see at all. Failing closed HERE — rather than
  // rendering a page of empty cards from a backend that returns nothing — is the difference between
  // "you don't have access" and "there is no payroll", which are not the same message.
  if (!can(me, "hr.payroll.view", tenant)) {
    return (
      <EmptyNote>
        Payroll is restricted to the HR manager tier and company administrators. Reading HR cases and
        records does not include the compensation surface — that split is deliberate.
      </EmptyNote>
    );
  }

  const [runs, parameterSets, separations] = await Promise.all([
    listPayrollRuns(userId, tenant),
    listParameterSets(userId, tenant),
    listSeparations(userId, tenant),
  ]);

  const canApprove = can(me, "hr.payroll.approve", tenant);
  const today = new Date().toISOString().slice(0, 10);
  const inForce = parameterSets.find(
    (s) => s.effectiveFrom <= today && (!s.effectiveTo || s.effectiveTo >= today),
  );
  const ratified = !!inForce?.ratifiedAt;
  const lastRun = runs[0];
  const overrideRuns = runs.filter((r) => r.unratifiedOverrideAt);
  const pendingSeparations = separations.filter((s) => s.status === "draft" || s.status === "pending_approval");

  return (
    <>
      {/* The gate, stated before any number. */}
      <div
        role="note"
        style={{
          marginBottom: 22, padding: "12px 16px", borderRadius: 10,
          border: `1px solid ${ratified ? "var(--erp-line)" : "var(--erp-warn, #b8860b)"}`,
          background: ratified ? "transparent" : "color-mix(in srgb, var(--erp-warn, #b8860b) 8%, transparent)",
          font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-80, var(--text-primary))",
        }}
      >
        {!inForce ? (
          <>
            <strong>No statutory parameter set covers today.</strong> The engine will compute with its
            built-in <em>unratified</em> fixture — tax brackets, BPJS rates and severance multipliers that
            nobody has verified. Configure and ratify a set on{" "}
            <Link href="/hr/settings" style={{ color: "var(--erp-accent)" }}>HR settings</Link> before approving
            anything.
          </>
        ) : ratified ? (
          <>
            Statutory parameters <strong>{inForce.name}</strong> are ratified
            {inForce.ratifiedAt ? ` (${inForce.ratifiedAt.slice(0, 10)})` : ""}. Runs calculated against
            this set can be approved normally.
          </>
        ) : (
          <>
            <strong>Statutory parameters “{inForce.name}” are NOT ratified.</strong> Payroll will still
            calculate, but approving a run against them requires an explicit override with a reason, and
            that override is recorded permanently on the run. Ratification is a company-administrator act —
            see <Link href="/hr/settings" style={{ color: "var(--erp-accent)" }}>HR settings</Link>.
          </>
        )}
      </div>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="Last run"
          value={lastRun ? lastRun.reference : "—"}
          foot={lastRun ? `${lastRun.status} · ${lastRun.periodStart} to ${lastRun.periodEnd}` : "no runs yet"}
        />
        <KpiTile
          label="Net paid"
          value={lastRun?.totalNet ? formatMoney(lastRun.totalNet, lastRun.currency) : "—"}
          foot={lastRun?.employeeCount != null ? `${lastRun.employeeCount} employee(s)` : undefined}
        />
        <KpiTile
          label="Employer cost"
          value={lastRun?.totalEmployerCost ? formatMoney(lastRun.totalEmployerCost, lastRun.currency) : "—"}
          foot="gross + employer contributions"
        />
        <KpiTile
          label="Unratified overrides"
          value={String(overrideRuns.length)}
          foot={overrideRuns.length ? "runs approved on unverified numbers" : "none"}
        />
      </div>

      <Card title="Payroll runs" style={{ marginBottom: 22 }}>
        {runs.length === 0 ? (
          <EmptyNote>
            No payroll runs yet. A run is drafted for a period, calculated, approved, published to
            employees, and then marked paid — four distinct steps, because approving a run and letting
            people see their payslip are different decisions.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Reference" }, { label: "Kind" }, { label: "Period" }, { label: "Status" },
              { label: "Employees", align: "right" }, { label: "Net", align: "right" },
            ]}
            rows={runs.map((r) => [
              <Link key={r.id} href={`/hr/payroll/${r.id}`} style={{ color: "var(--erp-accent)" }}>
                {r.reference}
              </Link>,
              <span key={`${r.id}-k`}>
                {r.kind}
                {r.unratifiedOverrideAt && (
                  <span
                    title="Approved against an unratified statutory parameter set"
                    style={{ marginLeft: 6, color: "var(--erp-warn, #b8860b)" }}
                  >
                    ⚠
                  </span>
                )}
              </span>,
              `${r.periodStart} → ${r.periodEnd}`,
              <StatusBadge key={`${r.id}-s`} label={r.status} />,
              r.employeeCount == null ? "—" : String(r.employeeCount),
              // A draft run has no total. "—" is the honest render; 0 would look like a run that
              // computed nothing, which is a different and much worse thing.
              r.totalNet ? formatMoney(r.totalNet, r.currency) : "—",
            ])}
          />
        )}
      </Card>

      <Card
        title="Separations"
        hint="Offboarding's money-and-compliance half. The checklist lives on the case; the severance computation lives here."
      >
        {separations.length === 0 ? (
          <EmptyNote>No separations recorded.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Employee" }, { label: "Ground" }, { label: "Effective" },
              { label: "Service", align: "right" }, { label: "Total", align: "right" }, { label: "Status" },
            ]}
            rows={separations.map((s) => [
              s.employeeName,
              s.ground.replace(/_/g, " "),
              s.effectiveOn,
              // Service years are computed from the job-event log, not from employees.hire_date — a
              // rehire is not one contiguous span.
              s.serviceYears ? `${Number(s.serviceYears).toFixed(1)}y` : "—",
              formatMoney(s.totalAmount, s.currency),
              <StatusBadge key={`${s.id}-s`} label={s.status} />,
            ])}
          />
        )}
        {pendingSeparations.length > 0 && canApprove && (
          <p style={{ margin: "12px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
            {pendingSeparations.length} separation(s) awaiting approval. Approving one writes the
            terminating job event and moves the employee record — it is not reversible by editing.
          </p>
        )}
      </Card>
    </>
  );
}
