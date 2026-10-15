import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listParameterSets, formatMoney } from "@/lib/hr-full";
import { getPayrollRunResult, listEmployeesResult } from "@/lib/hr-full-data";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PayrollRunActions } from "@/components/hr/PayrollRunActions";
import { PayrollInputForm } from "@/components/hr/PayrollInputForm";
import {
  addPayrollInput, calculatePayrollRun, approvePayrollRun, publishPayrollRun, markPayrollRunPaid,
} from "@/lib/hrPayrollActions";

type Params = Promise<{ runId: string }>;

// HR › Payroll › one run (DW-7f-1b). The list at /hr/payroll links here.
//
// Money rules this page holds:
//   - It shows what the server returned for the run and its payslips, nothing computed here. A figure
//     the server left null renders "—", never 0.
//   - The run and its payslips come from ONE read, so a refusal refuses both. It is rendered as a
//     refusal in words; there is never an empty table that could mean "no payslips" when the truth is
//     "you may not read them" or "the read failed".
//   - Inputs: the server has NO read for payroll inputs (only `POST payroll-inputs`), so the entered
//     inputs cannot be listed and the page says so. The form is offered only while the run can still be
//     calculated (draft, calculated): that is the only time the server can pick an input up. The
//     route itself does not check the run's status.
const ACCEPTS_INPUTS = ["draft", "calculated"];

const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

export default async function HrPayrollRunPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const { runId } = await params;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  if (!can(me, "hr.payroll.view", tenant)) {
    return (
      <EmptyNote>
        Payroll is restricted to the HR manager tier and company administrators. Reading HR cases and
        records does not include the compensation surface — that split is deliberate.
      </EmptyNote>
    );
  }

  const back = (
    <p style={{ margin: "0 0 14px", font: "400 13px var(--font-body)" }}>
      <Link href="/hr/payroll" style={{ color: "var(--erp-accent)" }}>← All payroll runs</Link>
    </p>
  );

  const result = await getPayrollRunResult(userId, tenant, runId);
  if (result.kind === "forbidden") {
    return <>{back}<ReadRefusal subject="this payroll run and its payslips" kind="forbidden" /></>;
  }
  if (result.kind === "unavailable") {
    return <>{back}<ReadRefusal subject="This payroll run and its payslips" kind="unavailable" reason={result.reason} /></>;
  }
  const run = result.data;
  if (!run) notFound();

  const canApprove = can(me, "hr.payroll.approve", tenant);
  const canManage = can(me, "hr.payroll.manage", tenant);
  const parameterSets = await listParameterSets(userId, tenant);
  const ratifiedSetIds = new Set(parameterSets.filter((s) => s.ratifiedAt).map((s) => s.id));
  const runApi = { calculate: calculatePayrollRun, approve: approvePayrollRun, publish: publishPayrollRun, markPaid: markPayrollRunPaid };
  const payslips = run.payslips ?? [];

  const acceptsInputs = ACCEPTS_INPUTS.includes(run.status);
  const employeesRead = canManage && acceptsInputs ? await listEmployeesResult(userId, tenant) : null;

  const stamps = [
    run.calculatedAt && `calculated ${run.calculatedAt.slice(0, 10)}`,
    run.approvedAt && `approved ${run.approvedAt.slice(0, 10)}`,
    run.paidAt && `paid ${run.paidAt.slice(0, 10)}`,
  ].filter(Boolean) as string[];

  return (
    <>
      {back}

      <Card title={run.reference} style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <dl style={{ display: "grid", gap: "8px 24px", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", margin: 0, font: "400 13px/1.5 var(--font-body)" }}>
            <Fact label="Kind" value={run.kind} />
            <Fact label="Period" value={`${run.periodStart} → ${run.periodEnd}`} />
            <Fact label="Pay date" value={run.payDate ?? "—"} />
            <Fact label="Status" value={<StatusBadge label={run.status} />} />
            <Fact label="Statutory parameters" value={
              run.parameterSetName
                ? `${run.parameterSetName}${run.parameterSetRatifiedAt ? ` (ratified ${run.parameterSetRatifiedAt.slice(0, 10)})` : " (not ratified)"}`
                : "none recorded"
            } />
          </dl>
          <div style={dim}>{stamps.join(" · ") || "Not calculated yet."}</div>
          {run.unratifiedOverrideAt && (
            <div role="note" style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid var(--erp-warn, #b8860b)", font: "400 13px/1.6 var(--font-body)" }}>
              <strong>Approved against an unratified statutory parameter set</strong> on {run.unratifiedOverrideAt.slice(0, 10)}.
              {run.unratifiedOverrideReason ? <> Reason given: “{run.unratifiedOverrideReason}”.</> : <> No reason was returned by the server.</>}
            </div>
          )}
          <PayrollRunActions
            tenantId={tenant}
            runId={run.id}
            reference={run.reference}
            status={run.status}
            canManage={canManage}
            canApprove={canApprove}
            needsOverride={!(run.parameterSetId && ratifiedSetIds.has(run.parameterSetId))}
            api={runApi}
          />
        </div>
      </Card>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="Employees" value={run.employeeCount == null ? "—" : String(run.employeeCount)} />
        <KpiTile label="Gross" value={run.totalGross ? formatMoney(run.totalGross, run.currency) : "—"} />
        <KpiTile label="Net" value={run.totalNet ? formatMoney(run.totalNet, run.currency) : "—"} />
        <KpiTile label="Employer cost" value={run.totalEmployerCost ? formatMoney(run.totalEmployerCost, run.currency) : "—"} foot="gross + employer contributions" />
      </div>

      <Card title="Payslips" style={{ marginBottom: 22 }}>
        {payslips.length === 0 ? (
          <EmptyNote>
            {run.status === "draft"
              ? "This run has not been calculated, so it has no payslips yet."
              : "The server returned no payslips for this run. Employees without a compensation record in force are skipped when a run is calculated."}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Employee" }, { label: "Gross", align: "right" }, { label: "Deductions", align: "right" },
              { label: "Tax withheld", align: "right" }, { label: "Net", align: "right" },
              { label: "Employer cost", align: "right" }, { label: "Status" },
            ]}
            rows={payslips.map((p) => [
              p.employeeName,
              formatMoney(p.gross, run.currency),
              formatMoney(p.employeeDeductions, run.currency),
              formatMoney(p.taxWithheld, run.currency),
              formatMoney(p.net, run.currency),
              formatMoney(p.employerCost, run.currency),
              <span key={`${p.id}-s`} style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <StatusBadge label={p.status} />
                <span style={dim}>{p.publishedAt ? `published ${p.publishedAt.slice(0, 10)}` : "not published"}</span>
              </span>,
            ])}
          />
        )}
      </Card>

      <Card title="Payroll inputs" style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gap: 12 }}>
          <p style={{ margin: 0, ...dim }}>
            Inputs (overtime, bonuses, reimbursements, deductions) belong to an employee and a period. A run
            counts the ones inside its period when it is calculated. The server offers no read of the inputs
            already entered, so they cannot be listed here; what a run counted shows on its payslips.
          </p>
          {!canManage ? null : !acceptsInputs ? (
            <p style={{ margin: 0, ...dim }}>
              This run is {run.status}, so it can no longer be calculated and would not count a new input.
              Raise a correction run for an adjustment.
            </p>
          ) : employeesRead?.kind === "ok" ? (
            <PayrollInputForm
              add={addPayrollInput}
              tenantId={tenant}
              runId={run.id}
              periodStart={run.periodStart}
              periodEnd={run.periodEnd}
              employees={employeesRead.data
                .filter((e) => e.employmentStatus === "active" || e.employmentStatus === "on_leave")
                .map((e) => ({ id: e.id, name: e.displayName }))}
            />
          ) : employeesRead?.kind === "forbidden" ? (
            <ReadRefusal inline subject="the employee list" kind="forbidden" detail="An input cannot be added without it." />
          ) : employeesRead?.kind === "unavailable" ? (
            <ReadRefusal inline subject="The employee list" kind="unavailable" reason={employeesRead.reason} detail="An input cannot be added without it." />
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
