"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { PayrollResult } from "@/lib/hrPayrollActions";
import "@/components/forms/forms.css";

const KINDS = ["regular", "thr", "bonus", "final", "correction"];

// "New payroll run" (DW-7f-1). Creates a DRAFT only; calculating, approving and paying are separate
// steps on the run. The server refuses a second regular run for the same period (409) and a reused
// reference (409); its words are shown as sent.
export function PayrollRunForm({ create, companyId, defaultCurrency }: {
  create: (formData: FormData) => Promise<PayrollResult>;
  companyId: string;
  defaultCurrency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) { setMsg(null); setOpen(false); }
      else setMsg(res.error ?? "The server refused this without giving a reason.");
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
          New payroll run
        </button>
      </div>
    );
  }

  return (
    <Card title="New payroll run" style={{ marginBottom: 22 }}>
      <form action={onSubmit} className="lux-form-grid">
        <input type="hidden" name="companyId" value={companyId} />
        <Field name="reference" label="Reference" required hint="Must be unique, e.g. PAY-2026-10" />
        <Field name="kind" label="Kind" type="select" options={KINDS} defaultValue="regular" required
          hint="Only one regular run per period; use correction for an off-cycle adjustment" />
        <Field name="periodStart" label="Period start" type="date" required />
        <Field name="periodEnd" label="Period end" type="date" required />
        <Field name="payDate" label="Pay date" type="date" />
        <Field name="currency" label="Currency" defaultValue={defaultCurrency} required hint="3-letter code" />
        {msg && (
          <p role="alert" style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Creating…" : "Create draft run"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setOpen(false); setMsg(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
