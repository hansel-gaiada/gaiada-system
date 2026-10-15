"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { CompensationResult } from "@/lib/hrCompensationActions";
import {
  RATE_BASES, PAY_FREQUENCIES, CHANGE_REASONS, ALLOWANCE_DIRECTIONS, CALC_KINDS, BENEFIT_KINDS, STATUTORY_CODES,
  PTKP_STATUSES, TER_CATEGORIES,
} from "@/lib/hrCompensation";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// The compensation write forms (DW-7f-3). Each is closed until opened, sends what the person typed to a server
// action, shows the SERVER's sentence as sent (a refusal in its own words, a success from its reply), and re-reads
// the page after every call, success or refusal. Nothing here decides: the page shows a form only to someone whose
// capability mirror says it is offered, and the server still decides. Rates, amounts and dates are not changed here.

export type FormApi = (tenantId: string, formData: FormData) => Promise<CompensationResult>;
export type Option = { value: string; label: string };

function FormShell({ title, openLabel, submitLabel, pendingLabel, tenantId, action, children, intro, closeOnSuccess = false }: {
  title: string;
  openLabel: string;
  submitLabel: string;
  pendingLabel: string;
  tenantId: string;
  action: FormApi;
  children: ReactNode;
  intro?: ReactNode;
  closeOnSuccess?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await action(tenantId, formData);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Saved." });
        setFormKey((k) => k + 1); // a fresh form, ready for the next one
        if (closeOnSuccess) setOpen(false);
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: after a refusal the view may be stale
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            {openLabel}
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label={title}>
      {intro ? <p style={{ margin: 0, ...fullRow, ...dimStyle }}>{intro}</p> : null}
      {children}
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Close
        </button>
      </div>
    </form>
  );
}

const employeeField = (employees: Option[]) => (
  <Field name="employeeId" label="Employee" type="select" required placeholder="Select an employee…" optionItems={employees} />
);

// ---- Set compensation ----
export function SetCompensationForm({ tenantId, action, employees, grades, gradesNote, defaultCurrency }: {
  tenantId: string;
  action: FormApi;
  employees: Option[];
  /** Pay grades the server returned, when the read worked. Without them the grade field is not offered. */
  grades: Option[] | null;
  /** Why there is no grade field, when `grades` is null (the pay-grade read was refused or failed). */
  gradesNote?: string;
  defaultCurrency: string;
}) {
  return (
    <FormShell title="Set compensation" openLabel="Set compensation" submitLabel="Record compensation" pendingLabel="Recording…"
      tenantId={tenantId} action={action}
      intro="A new record closes the one in force the day before it starts; the earlier record stays as history. The date must be after the start of the record in force, and the server says so if it is not.">
      {employeeField(employees)}
      <Field name="baseAmount" label="Base amount" type="number" step="any" required hint="Per the rate basis below" />
      <Field name="currency" label="Currency" defaultValue={defaultCurrency} hint="3-letter code" />
      <Field name="rateBasis" label="Rate basis" type="select" options={[...RATE_BASES]} defaultValue="monthly" required
        hint="The unit the amount is quoted in" />
      <Field name="payFrequency" label="Pay frequency" type="select" options={[...PAY_FREQUENCIES]} defaultValue="monthly" required
        hint="How often a payslip is produced" />
      <Field name="fte" label="FTE" type="number" step="any" hint="0.001 to 2; blank means 1" />
      <Field name="effectiveFrom" label="Effective from" type="date" required />
      <Field name="changeReason" label="Reason" type="select" options={[...CHANGE_REASONS]} defaultValue="other" required />
      {grades ? (
        <Field name="gradeId" label="Pay grade" type="select" optionItems={grades} placeholder="No grade"
          hint="The server refuses an amount outside the grade's band" />
      ) : (
        <p style={{ margin: 0, ...dimStyle }}>{gradesNote ?? "Pay grades could not be read, so no grade can be chosen here."}</p>
      )}
      <Field name="note" label="Note" />
    </FormShell>
  );
}

// ---- Allowance type ----
export function AllowanceTypeForm({ tenantId, action }: { tenantId: string; action: FormApi }) {
  return (
    <FormShell title="Save allowance type" openLabel="Add allowance type" submitLabel="Save allowance type" pendingLabel="Saving…"
      tenantId={tenantId} action={action}
      intro="Saving with a code that already exists REPLACES that type's settings in place. Check the list above before you save.">
      <Field name="code" label="Code" required hint="The key. An existing code is overwritten" />
      <Field name="label" label="Label" required hint="Prints on the payslip" />
      <Field name="direction" label="Direction" type="select" options={[...ALLOWANCE_DIRECTIONS]} defaultValue="allowance" required />
      <Field name="calcKind" label="Calculated as" type="select" options={[...CALC_KINDS]} defaultValue="fixed" required />
      <Field name="defaultAmount" label="Default amount" type="number" step="any" hint="Used when an assignment gives none" />
      <Field name="defaultPercent" label="Default percent" type="number" step="any" hint="0 to 100, of the period's base" />
      <Field name="taxable" label="Taxable" type="boolean" defaultValue />
      <Field name="bpjsBase" label="Counts toward the BPJS base" type="boolean" />
      <Field name="prorated" label="Prorated for part periods" type="boolean" defaultValue />
    </FormShell>
  );
}

// ---- Assign an allowance ----
export function AssignAllowanceForm({ tenantId, action, employees, types }: {
  tenantId: string; action: FormApi; employees: Option[]; types: Option[];
}) {
  return (
    <FormShell title="Assign allowance" openLabel="Assign an allowance" submitLabel="Assign allowance" pendingLabel="Assigning…"
      tenantId={tenantId} action={action}
      intro="Leave the amount and percent blank to use the type's default. The server refuses a second holding of the same type over an overlapping period.">
      {employeeField(employees)}
      <Field name="allowanceTypeId" label="Allowance type" type="select" required placeholder="Select a type…" optionItems={types} />
      <Field name="amount" label="Amount" type="number" step="any" hint="Money, per period" />
      <Field name="percent" label="Percent" type="number" step="any" hint="0 to 100, for a percentage type" />
      <Field name="effectiveFrom" label="From" type="date" required />
      <Field name="effectiveTo" label="Until" type="date" hint="Blank means open-ended" />
      <Field name="note" label="Note" />
    </FormShell>
  );
}

// ---- Benefit plan ----
export function BenefitPlanForm({ tenantId, action, defaultCurrency }: { tenantId: string; action: FormApi; defaultCurrency: string }) {
  return (
    <FormShell title="Save benefit plan" openLabel="Add benefit plan" submitLabel="Save benefit plan" pendingLabel="Saving…"
      tenantId={tenantId} action={action}
      intro="Saving with a code that already exists REPLACES that plan's settings in place (its currency is kept). The payroll engine reads statutory rates from the parameter set, not from these columns.">
      <Field name="code" label="Code" required hint="The key. An existing code is overwritten" />
      <Field name="name" label="Name" required />
      <Field name="kind" label="Kind" type="select" options={[...BENEFIT_KINDS]} defaultValue="statutory" required />
      <Field name="statutoryCode" label="Statutory code" type="select" options={[...STATUTORY_CODES]} placeholder="None"
        hint="Set for BPJS plans: the engine recognizes them by this, never by name" />
      <Field name="provider" label="Provider" />
      <Field name="currency" label="Currency" defaultValue={defaultCurrency} hint="3-letter code" />
      <Field name="employerRate" label="Employer rate (%)" type="number" step="any" hint="0 to 100, up to 2 decimals" />
      <Field name="employeeRate" label="Employee rate (%)" type="number" step="any" hint="0 to 100, up to 2 decimals" />
      <Field name="wageCap" label="Wage cap" type="number" step="any" hint="Blank means uncapped" />
      <Field name="wageFloor" label="Wage floor" type="number" step="any" />
    </FormShell>
  );
}

// ---- Enrol in a benefit plan ----
export function EnrolBenefitForm({ tenantId, action, employees, plans }: {
  tenantId: string; action: FormApi; employees: Option[]; plans: Option[];
}) {
  return (
    <FormShell title="Enrol in benefit plan" openLabel="Enrol in a benefit plan" submitLabel="Enrol" pendingLabel="Enrolling…"
      tenantId={tenantId} action={action}
      intro="The server refuses a second enrolment in the same plan over an overlapping period.">
      {employeeField(employees)}
      <Field name="planId" label="Benefit plan" type="select" required placeholder="Select a plan…" optionItems={plans} />
      <Field name="memberNumber" label="Member number" hint="The provider's number for this person" />
      <Field name="dependants" label="Dependants" type="number" hint="Whole number, zero or more" />
      <Field name="effectiveFrom" label="From" type="date" required />
      <Field name="effectiveTo" label="Until" type="date" hint="Blank means open-ended" />
    </FormShell>
  );
}

// ---- Tax profile ----
export function TaxProfileForm({ tenantId, action, employees }: { tenantId: string; action: FormApi; employees: Option[] }) {
  return (
    <FormShell title="Set tax profile" openLabel="Set a tax profile" submitLabel="Record tax profile" pendingLabel="Recording…"
      tenantId={tenantId} action={action}
      intro="A new profile closes the one in force the day before it starts. Without an NPWP the employee is withheld at the higher rate.">
      {employeeField(employees)}
      <Field name="ptkpStatus" label="PTKP status" type="select" options={[...PTKP_STATUSES]} defaultValue="TK/0" required />
      <Field name="terCategory" label="TER category" type="select" options={[...TER_CATEGORIES]} placeholder="Server decides from PTKP"
        hint="Leave blank to let the server derive it from the PTKP status" />
      <Field name="npwp" label="NPWP" hint="Blank means none" />
      <Field name="effectiveFrom" label="Effective from" type="date" required />
      <Field name="taxResident" label="Tax resident" type="boolean" defaultValue />
    </FormShell>
  );
}
