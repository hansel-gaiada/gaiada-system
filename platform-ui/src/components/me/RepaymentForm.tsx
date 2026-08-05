"use client";
// Record a loan repayment (wave E) — STAFF ONLY. The caller decides whether to render this at all
// (`can(me, "hr.manage", tenant)`); the server independently authorizes it as hr_case:update, which
// the `member` derived role does not hold, so an employee cannot record a payment against their own
// loan even by posting directly.
//
// 'Payroll deduction' is selectable but nothing writes it automatically yet — employee-portal wave D
// (payroll) is deferred, and when it lands it becomes the automated writer of exactly this row.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import { METHOD_LABEL, REPAYMENT_METHODS } from "@/lib/loans";
import type { LoanResult } from "@/lib/loanActions";
import "@/components/forms/forms.css";

export function RepaymentForm({ record, companyId, loanId, outstanding, currency }: {
  record: (formData: FormData) => Promise<LoanResult>;
  companyId: string;
  loanId: string;
  outstanding: number;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await record(formData);
      if (res.ok) {
        setMsg(null);
        setOpen(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't record the repayment.");
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--sm" onClick={() => setOpen(true)}>
        Record repayment
      </button>
    );
  }

  return (
    <Card title="Record a repayment" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="loanId" value={loanId} />
        <Field
          name="amount" label={`Amount (${currency})`} type="number" required
          // Defaulting to the full outstanding balance makes the common "settle it" case one click,
          // and any partial amount is still allowed.
          defaultValue={outstanding > 0 ? outstanding : undefined}
        />
        <Field name="paidOn" label="Paid on" type="date" hint="Defaults to today." />
        <Field
          name="method" label="Method" type="select"
          optionItems={REPAYMENT_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          defaultValue="transfer"
        />
        <Field name="note" label="Note (optional)" type="textarea" />
        {msg && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Recording…" : "Record repayment"}
          </button>
          <button type="button" className="lux-btn lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
