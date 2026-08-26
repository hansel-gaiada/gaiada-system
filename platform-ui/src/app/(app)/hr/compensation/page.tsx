import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listCompensation, listPayGrades, listAllowanceTypes, listBenefitPlans, formatMoney, monthlyEquivalent } from "@/lib/hr-full";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// HR › Compensation — the effective-dated pay record, the grade structure, allowances and benefits
// (HR-FULL wave C).
//
// The single rule this whole surface is built on: COMPENSATION IS CLOSED, NEVER OVERWRITTEN. A raise
// closes the incumbent row and opens a new one, and a database exclusion constraint makes two
// simultaneous open rows impossible. That is what lets payroll recompute any past period exactly —
// and it is why this page shows a HISTORY per person rather than a single editable salary field.
export default async function HrCompensationPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // Same gate as /hr/payroll, and for the same reason: this is the salary book.
  if (!can(me, "hr.payroll.view", tenant)) {
    return (
      <EmptyNote>
        Compensation is restricted to the HR manager tier and company administrators. Reading HR cases
        and records does not include it.
      </EmptyNote>
    );
  }

  const [current, grades, allowances, plans] = await Promise.all([
    listCompensation(userId, tenant, { current: true }),
    listPayGrades(userId, tenant),
    listAllowanceTypes(userId, tenant),
    listBenefitPlans(userId, tenant),
  ]);

  const currency = current[0]?.currency ?? "IDR";
  // Monthly-equivalent payroll cost of the standing base pay.
  //
  // Annual and daily rows used to be EXCLUDED here, because converting them needed a multiplier
  // this page would have had to invent. It no longer does: `monthlyEquivalent` is the same
  // annualisation the payroll engine and the database both use, so the headline can now include
  // every row whose basis is convertible. Piece-rate still cannot be converted from a rate alone,
  // so it is excluded and COUNTED — a narrower headline that says how narrow it is.
  const converted = current.map((c) => ({
    c, monthly: monthlyEquivalent(Number(c.baseAmount), c.rateBasis),
  }));
  const monthly = converted.filter((x) => x.monthly !== null);
  const unconvertible = converted.length - monthly.length;
  const monthlyBase = monthly.reduce((sum, x) => sum + (x.monthly as number) * Number(x.c.fte), 0);
  const ungraded = current.filter((c) => !c.gradeId).length;
  const statutory = plans.filter((p) => p.statutoryCode);

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="On a pay record" value={String(current.length)} foot="employees with compensation in force" />
        <KpiTile
          label="Monthly base"
          value={formatMoney(monthlyBase, currency)}
          foot={unconvertible === 0 ? "FTE-weighted, all rate bases" : `FTE-weighted; ${unconvertible} of ${current.length} not convertible from a rate`}
        />
        <KpiTile label="Pay grades" value={String(grades.length)} foot={ungraded ? `${ungraded} person(s) ungraded` : "all graded"} />
        <KpiTile label="Benefit plans" value={String(plans.length)} foot={`${statutory.length} statutory`} />
      </div>

      <Card
        title="Compensation in force"
        hint="One row per person — the open-ended record. A raise closes this row and opens a new one; the history stays."
        style={{ marginBottom: 22 }}
      >
        {current.length === 0 ? (
          <EmptyNote>
            Nobody has a compensation record. Payroll SKIPS an employee with no record in force and
            reports the skip rather than paying them zero — so an empty table here means an empty payroll,
            visibly.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Employee" }, { label: "Grade" }, { label: "Base", align: "right" },
              // The basis is shown NEXT TO the amount, not inferred. A monthly 12,000,000 and an
              // annual 12,000,000 are a twelvefold difference and render identically without it.
              { label: "Per" }, { label: "Paid" },
              { label: "FTE", align: "right" }, { label: "Since" }, { label: "Reason" },
            ]}
            rows={current.map((c) => [
              c.employeeName,
              c.gradeCode ?? "—",
              formatMoney(c.baseAmount, c.currency),
              c.rateBasis.replace(/_/g, " "),
              c.payFrequency.replace(/_/g, " "),
              Number(c.fte).toFixed(2),
              c.effectiveFrom,
              c.changeReason?.replace(/_/g, " ") ?? "—",
            ])}
          />
        )}
      </Card>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 22 }}>
        <Card title="Pay grades" hint="Optional. Where grades exist, an offer or a raise outside the band is refused.">
          {grades.length === 0 ? (
            <EmptyNote>No grade structure defined — compensation is set freehand.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Code" }, { label: "Track" }, { label: "Band", align: "right" }]}
              rows={grades.map((g) => [
                `${g.code} · ${g.name}`,
                `${g.track} L${g.level}`,
                `${formatMoney(g.minAmount, g.currency)} – ${formatMoney(g.maxAmount, g.currency)}`,
              ])}
            />
          )}
        </Card>

        <Card
          title="Allowance & deduction types"
          hint="`Taxable` and `BPJS base` are independent on purpose — Indonesian practice treats the two bases differently per component."
        >
          {allowances.length === 0 ? (
            <EmptyNote>No allowance types defined.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Code" }, { label: "Direction" }, { label: "Taxable" }, { label: "BPJS base" }]}
              rows={allowances.map((a) => [
                `${a.code} · ${a.label}`,
                a.direction,
                a.taxable ? "yes" : "no",
                a.bpjsBase ? "yes" : "no",
              ])}
            />
          )}
        </Card>
      </div>

      <Card
        title="Benefit plans"
        hint="Statutory plans are recognized by their regulatory code, never by name — the payroll engine reads rates from the effective-dated parameter set, not from these columns."
      >
        {plans.length === 0 ? (
          <EmptyNote>
            No benefit plans. BPJS Kesehatan and the four BPJS Ketenagakerjaan programs (JHT, JP, JKK, JKM)
            each need their own plan, because each carries a different rate, a different cap, and a
            different employer/employee split.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Plan" }, { label: "Statutory code" }, { label: "Employer", align: "right" },
              { label: "Employee", align: "right" }, { label: "Wage cap", align: "right" },
            ]}
            rows={plans.map((p) => [
              `${p.code} · ${p.name}`,
              p.statutoryCode ?? "—",
              p.employerRate ? `${(Number(p.employerRate) * 100).toFixed(2)}%` : "—",
              p.employeeRate ? `${(Number(p.employeeRate) * 100).toFixed(2)}%` : "—",
              p.wageCap ? formatMoney(p.wageCap, p.currency) : "uncapped",
            ])}
          />
        )}
      </Card>
    </>
  );
}
