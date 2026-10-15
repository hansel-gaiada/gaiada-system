"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import type { PayrollResult } from "@/lib/hrPayrollActions";
import "@/components/forms/forms.css";

const CATEGORIES = ["overtime", "bonus", "commission", "reimbursement", "deduction", "advance", "leave_encashment", "other"];

// "Add input" on a payroll run (DW-7f-1b). A payroll input is a per-employee, per-period fact (overtime
// hours, a bonus, a reimbursement, a deduction). It is not attached to the run: the server counts it the
// next time a run whose period contains it is calculated. The period is therefore the run's own period,
// sent from the values the page read; the employee list is the server's. The server's refusal is shown
// as sent, and the sentence after a success repeats what the server will do, not a payslip figure.
export function PayrollInputForm({ add, tenantId, runId, periodStart, periodEnd, employees }: {
  add: (tenantId: string, runId: string, formData: FormData) => Promise<PayrollResult>;
  tenantId: string;
  runId: string;
  periodStart: string;
  periodEnd: string;
  employees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await add(tenantId, runId, formData);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Input recorded." });
        setFormKey((k) => k + 1); // a fresh form, ready for the next input
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
            Add input
          </button>
        </div>
        {msg && <Message msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label="Add payroll input">
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />
      <Field name="employeeId" label="Employee" type="select" required placeholder="Select an employee…"
        optionItems={employees.map((e) => ({ value: e.id, label: e.name }))} />
      <Field name="category" label="Category" type="select" options={CATEGORIES} required
        hint="Deductions and advances are taken off; enter their amount as a positive number" />
      <Field name="label" label="Label" required hint="Prints on the payslip" />
      <Field name="amount" label="Amount" type="number" hint="Money, when you know it" />
      <Field name="quantity" label="Quantity" type="number" hint="Hours, for overtime; the server prices them" />
      <Field name="taxable" label="Taxable" type="boolean" defaultValue />
      <Field name="note" label="Note" />
      <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
        Applies to the period {periodStart} to {periodEnd}. Give an amount or a quantity.
      </p>
      {msg && <div style={{ gridColumn: "1 / -1" }}><Message msg={msg} /></div>}
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Adding…" : "Add input"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Close
        </button>
      </div>
    </form>
  );
}

function Message({ msg }: { msg: { ok: boolean; text: string } }) {
  return (
    <p role={msg.ok ? "status" : "alert"}
      style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: msg.ok ? "var(--erp-ink-80, inherit)" : "var(--erp-accent)" }}>
      {msg.text}
    </p>
  );
}
