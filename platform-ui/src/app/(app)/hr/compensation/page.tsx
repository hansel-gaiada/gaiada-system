import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { formatMoney, monthlyEquivalent } from "@/lib/hr-full";
import {
  listCompensationResult, listPayGradesResult, listAllowanceTypesResult, listBenefitPlansResult, listEmployeesResult,
  listEmployeeAllowancesResult, listEmployeeBenefitsResult, getEmployeeTaxProfileResult,
} from "@/lib/hr-full-data";
import type { ReadResult } from "@/lib/readResult";
import { PICKABLE_EMPLOYEE_STATUSES, label } from "@/lib/hrCompensation";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EmployeeOnFile, type OnFileKey } from "@/components/hr/EmployeeOnFile";
import {
  SetCompensationForm, AllowanceTypeForm, AssignAllowanceForm, BenefitPlanForm, EnrolBenefitForm, TaxProfileForm,
} from "@/components/hr/CompensationForms";
import {
  setCompensation, saveAllowanceType, assignAllowance, saveBenefitPlan, enrolBenefit, setTaxProfile,
} from "@/lib/hrCompensationActions";

type SearchParams = Promise<{ employee?: string | string[]; history?: string | string[] }>;
const ON_FILE_KEYS: readonly OnFileKey[] = ["allowances", "benefits", "tax"];

// HR › Compensation — the effective-dated pay record, the grade structure, allowances and benefits
// (HR-FULL wave C; the write screens are DW-7f-3).
//
// The single rule this whole surface is built on: COMPENSATION IS CLOSED, NEVER OVERWRITTEN. A raise
// closes the incumbent row and opens a new one, and a database exclusion constraint makes two
// simultaneous open rows impossible. That is what lets payroll recompute any past period exactly —
// and it is why this page shows a HISTORY per person rather than a single editable salary field.
//
// Money rules this page holds:
//   - Every list is an honest read (ReadResult). A refused or failed read is said in words; it is never an
//     empty table that could mean "nobody has a pay record". Figures are the server's strings, formatted only.
//   - The page is re-read after every write (router.refresh plus the action's revalidatePath), so what shows
//     after a save is what the server holds.
//   - Layout: ONE page in sections (in force, history and what is on file on `?employee=`, grades, allowance types,
//     benefit plans, and the per-employee forms) rather than a detail route.
//   - What is on file (DW-7f-3b, BFF §51): with `?employee=` the page reads that person's allowances and benefit
//     enrolments in force (`current=true`) and their tax profile, each as its own honest read. `&history=` is a
//     comma list of allowances, benefits and tax: a listed one is read WITHOUT the in-force filter, so closed rows
//     show. "In force today" is the server's call (REPORTS_TZ), never this page's clock.
//   - Controls follow the capability mirror: hr.payroll.view reads; hr.payroll.manage shows every form (all six
//     routes are Cerbos `hr_payroll` create). The server still decides.
const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

function Refused<T>({ read, subject }: { read: Exclude<ReadResult<T>, { kind: "ok" }>; subject: string }) {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return read.kind === "forbidden"
    ? <ReadRefusal inline subject={subject} kind="forbidden" />
    : <ReadRefusal inline subject={Subject} kind="unavailable" reason={read.reason} />;
}

export default async function HrCompensationPage({ searchParams }: { searchParams: SearchParams }) {
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

  const sp = await searchParams;
  const employeeParam = Array.isArray(sp?.employee) ? sp.employee[0] : sp?.employee;
  const historyParam = Array.isArray(sp?.history) ? sp.history[0] : sp?.history;
  const shownKeys = new Set((historyParam ?? "").split(",").filter((k): k is OnFileKey => (ON_FILE_KEYS as readonly string[]).includes(k)));
  const canManage = can(me, "hr.payroll.manage", tenant);

  const [
    currentRead, gradesRead, allowancesRead, plansRead, employeesRead, historyRead,
    onFileAllowancesRead, onFileBenefitsRead, onFileTaxRead,
  ] = await Promise.all([
    listCompensationResult(userId, tenant, { current: true }),
    listPayGradesResult(userId, tenant),
    listAllowanceTypesResult(userId, tenant),
    listBenefitPlansResult(userId, tenant),
    canManage ? listEmployeesResult(userId, tenant) : null,
    employeeParam ? listCompensationResult(userId, tenant, { employeeId: employeeParam }) : null,
    employeeParam ? listEmployeeAllowancesResult(userId, tenant, employeeParam, { current: !shownKeys.has("allowances") }) : null,
    employeeParam ? listEmployeeBenefitsResult(userId, tenant, employeeParam, { current: !shownKeys.has("benefits") }) : null,
    employeeParam ? getEmployeeTaxProfileResult(userId, tenant, employeeParam) : null,
  ]);

  // The link that toggles one list's history, keeping the others as they are.
  const onFileHref = (key: OnFileKey) => {
    const next = new Set(shownKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    const keep = ON_FILE_KEYS.filter((k) => next.has(k));
    return `/hr/compensation?employee=${encodeURIComponent(employeeParam as string)}${keep.length ? `&history=${keep.join(",")}` : ""}`;
  };
  const onFileName = (currentRead.kind === "ok" ? currentRead.data.find((c) => c.employeeId === employeeParam)?.employeeName : undefined)
    ?? (historyRead?.kind === "ok" ? historyRead.data[0]?.employeeName : undefined) ?? null;

  const current = currentRead.kind === "ok" ? currentRead.data : [];
  const grades = gradesRead.kind === "ok" ? gradesRead.data : [];
  const allowances = allowancesRead.kind === "ok" ? allowancesRead.data : [];
  const plans = plansRead.kind === "ok" ? plansRead.data : [];
  const currency = current[0]?.currency ?? "IDR";

  // Monthly-equivalent payroll cost of the standing base pay. `monthlyEquivalent` is the same annualisation the
  // payroll engine and the database use; piece-rate cannot be converted from a rate alone, so it is excluded and
  // COUNTED — a narrower headline that says how narrow it is.
  const converted = current.map((c) => ({ c, monthly: monthlyEquivalent(Number(c.baseAmount), c.rateBasis) }));
  const monthly = converted.filter((x) => x.monthly !== null);
  const unconvertible = converted.length - monthly.length;
  const monthlyBase = monthly.reduce((sum, x) => sum + (x.monthly as number) * Number(x.c.fte), 0);
  const ungraded = current.filter((c) => !c.gradeId).length;
  const statutory = plans.filter((p) => p.statutoryCode);

  const employeeOptions = employeesRead?.kind === "ok"
    ? employeesRead.data
        .filter((e) => PICKABLE_EMPLOYEE_STATUSES.includes(e.employmentStatus))
        .map((e) => ({ value: e.id, label: e.displayName }))
    : [];
  const needsEmployees = (children: React.ReactNode) =>
    employeesRead?.kind === "ok" ? children
      : employeesRead ? <Refused read={employeesRead} subject="the employee list" />
      : null;

  const typeOptions = allowances.map((a) => ({ value: a.id, label: `${a.code} · ${a.label}${a.isActive ? "" : " (inactive)"}` }));
  const planOptions = plans.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}${p.isActive ? "" : " (inactive)"}` }));
  const gradeOptions = gradesRead.kind === "ok"
    ? gradesRead.data.filter((g) => g.isActive).map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))
    : null;
  const gradesNote = gradesRead.kind === "forbidden"
    ? "You can't read pay grades, so no grade can be chosen here."
    : gradesRead.kind === "unavailable" ? "Pay grades cannot be read right now, so no grade can be chosen here." : undefined;

  return (
    <>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile
          label="On a pay record"
          value={currentRead.kind === "ok" ? String(current.length) : "—"}
          foot={currentRead.kind === "ok" ? "employees with compensation in force" : "cannot be read"}
        />
        <KpiTile
          label="Monthly base"
          value={currentRead.kind === "ok" ? formatMoney(monthlyBase, currency) : "—"}
          foot={currentRead.kind !== "ok" ? "cannot be read"
            : unconvertible === 0 ? "FTE-weighted, all rate bases" : `FTE-weighted; ${unconvertible} of ${current.length} not convertible from a rate`}
        />
        <KpiTile
          label="Pay grades"
          value={gradesRead.kind === "ok" ? String(grades.length) : "—"}
          foot={gradesRead.kind !== "ok" ? "cannot be read"
            : currentRead.kind !== "ok" ? undefined : ungraded ? `${ungraded} person(s) ungraded` : "all graded"}
        />
        <KpiTile
          label="Benefit plans"
          value={plansRead.kind === "ok" ? String(plans.length) : "—"}
          foot={plansRead.kind === "ok" ? `${statutory.length} statutory` : "cannot be read"}
        />
      </div>

      <Card
        title="Compensation in force"
        hint="One row per person — the open-ended record. A raise closes this row and opens a new one; the history stays."
        style={{ marginBottom: 22 }}
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && needsEmployees(
            <SetCompensationForm
              tenantId={tenant} action={setCompensation} employees={employeeOptions}
              grades={gradeOptions} gradesNote={gradesNote} defaultCurrency={currency}
            />,
          )}
          {currentRead.kind !== "ok" ? (
            <Refused read={currentRead} subject="the compensation records" />
          ) : current.length === 0 ? (
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
                { label: "FTE", align: "right" }, { label: "Since" }, { label: "Reason" }, { label: "History" },
              ]}
              rows={current.map((c) => [
                c.employeeName,
                c.gradeCode ?? "—",
                formatMoney(c.baseAmount, c.currency),
                label(c.rateBasis),
                label(c.payFrequency),
                Number(c.fte).toFixed(2),
                c.effectiveFrom,
                c.changeReason ? label(c.changeReason) : "—",
                <Link key={c.id} href={`/hr/compensation?employee=${encodeURIComponent(c.employeeId)}`}
                  aria-label={`Pay history for ${c.employeeName}`} style={{ color: "var(--erp-accent)" }}>
                  View
                </Link>,
              ])}
            />
          )}
        </div>
      </Card>

      {employeeParam && historyRead && (
        <Card
          title={`Pay history${historyRead.kind === "ok" && historyRead.data[0] ? ` — ${historyRead.data[0].employeeName}` : ""}`}
          hint="Every record the server holds for this person, newest first. A closed record has an end date."
          style={{ marginBottom: 22 }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
              <Link href="/hr/compensation" style={{ color: "var(--erp-accent)" }}>Close history</Link>
            </p>
            {historyRead.kind !== "ok" ? (
              <Refused read={historyRead} subject="this person's pay history" />
            ) : historyRead.data.length === 0 ? (
              <EmptyNote>The server holds no compensation record for this employee.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[
                  { label: "From" }, { label: "To" }, { label: "Base", align: "right" }, { label: "Per" }, { label: "Paid" },
                  { label: "FTE", align: "right" }, { label: "Grade" }, { label: "Reason" }, { label: "Note" },
                ]}
                rows={historyRead.data.map((h) => [
                  h.effectiveFrom,
                  h.effectiveTo ?? "in force",
                  formatMoney(h.baseAmount, h.currency),
                  label(h.rateBasis),
                  label(h.payFrequency),
                  Number(h.fte).toFixed(2),
                  h.gradeCode ?? "—",
                  h.changeReason ? label(h.changeReason) : "—",
                  h.note || "—",
                ])}
              />
            )}
          </div>
        </Card>
      )}

      {employeeParam && onFileAllowancesRead && onFileBenefitsRead && onFileTaxRead && (
        <EmployeeOnFile
          employeeName={onFileName}
          closeHref="/hr/compensation"
          hrefFor={onFileHref}
          shown={{ allowances: shownKeys.has("allowances"), benefits: shownKeys.has("benefits"), tax: shownKeys.has("tax") }}
          currency={currency}
          allowancesRead={onFileAllowancesRead}
          benefitsRead={onFileBenefitsRead}
          taxRead={onFileTaxRead}
        />
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 22 }}>
        <Card title="Pay grades" hint="Optional. Where grades exist, an offer or a raise outside the band is refused.">
          {gradesRead.kind !== "ok" ? (
            <Refused read={gradesRead} subject="the pay grades" />
          ) : grades.length === 0 ? (
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
          <div style={{ display: "grid", gap: 12 }}>
            {canManage && <AllowanceTypeForm tenantId={tenant} action={saveAllowanceType} />}
            {allowancesRead.kind !== "ok" ? (
              <Refused read={allowancesRead} subject="the allowance types" />
            ) : allowances.length === 0 ? (
              <EmptyNote>No allowance types defined.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Code" }, { label: "Direction" }, { label: "Taxable" }, { label: "BPJS base" }]}
                rows={allowances.map((a) => [
                  `${a.code} · ${a.label}${a.isActive ? "" : " (inactive)"}`,
                  a.direction,
                  a.taxable ? "yes" : "no",
                  a.bpjsBase ? "yes" : "no",
                ])}
              />
            )}
          </div>
        </Card>
      </div>

      <Card
        title="Benefit plans"
        hint="Statutory plans are recognized by their regulatory code, never by name — the payroll engine reads rates from the effective-dated parameter set, not from these columns."
        style={{ marginBottom: 22 }}
      >
        <div style={{ display: "grid", gap: 12 }}>
          {canManage && <BenefitPlanForm tenantId={tenant} action={saveBenefitPlan} defaultCurrency={currency} />}
          {plansRead.kind !== "ok" ? (
            <Refused read={plansRead} subject="the benefit plans" />
          ) : plans.length === 0 ? (
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
                `${p.code} · ${p.name}${p.isActive ? "" : " (inactive)"}`,
                p.statutoryCode ?? "—",
                p.employerRate ? `${(Number(p.employerRate) * 100).toFixed(2)}%` : "—",
                p.employeeRate ? `${(Number(p.employeeRate) * 100).toFixed(2)}%` : "—",
                p.wageCap ? formatMoney(p.wageCap, p.currency) : "uncapped",
              ])}
            />
          )}
        </div>
      </Card>

      {canManage && (
        <Card
          title="Allowances, benefits and tax profile"
          hint="Per employee. Each save is dated, and the server closes or refuses an overlap in its own words."
        >
          <div style={{ display: "grid", gap: 12 }}>
            <p role="note" style={{ margin: 0, ...dim }}>
              What is already assigned or on file for a person is listed under their name: choose View in the
              compensation table above. A save is confirmed by the server&apos;s reply and the lists are re-read after
              it; the effect shows on the payslips when a run is calculated.
            </p>
            {needsEmployees(
              <>
                {allowancesRead.kind === "ok" ? (
                  <AssignAllowanceForm tenantId={tenant} action={assignAllowance} employees={employeeOptions} types={typeOptions} />
                ) : (
                  <Refused read={allowancesRead} subject="the allowance types an allowance is assigned from" />
                )}
                {plansRead.kind === "ok" ? (
                  <EnrolBenefitForm tenantId={tenant} action={enrolBenefit} employees={employeeOptions} plans={planOptions} />
                ) : (
                  <Refused read={plansRead} subject="the benefit plans an employee is enrolled in" />
                )}
                <TaxProfileForm tenantId={tenant} action={setTaxProfile} employees={employeeOptions} />
              </>,
            )}
          </div>
        </Card>
      )}
    </>
  );
}
