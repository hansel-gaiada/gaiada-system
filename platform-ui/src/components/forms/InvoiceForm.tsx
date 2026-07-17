"use client";
import { useActionState } from "react";
import { Field } from "./Field";
import { Eyebrow, Button } from "@/components/ui";
import type { BillingState } from "@/lib/billingActions";
import "./forms.css";

export function InvoiceForm({
  action, clients,
}: {
  action: (prev: BillingState | null, fd: FormData) => Promise<BillingState>;
  clients: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Client</Eyebrow>
        <select name="clientId" className="lux-field__control" defaultValue="">
          <option value="" disabled hidden />
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <Field name="currency" label="Currency" type="select" options={["USD", "EUR", "GBP", "IDR", "SGD"]} defaultValue="USD" />
      <Field name="periodStart" label="Period start" type="date" />
      <Field name="periodEnd" label="Period end" type="date" />
      <Field name="rate" label="Hourly rate" type="number" required />
      {state?.error && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p>}
      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>{pending ? "Generating…" : "Generate invoice"}</Button>
      </div>
      <p style={{ gridColumn: "1 / -1", margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
        Lines are generated from billable time logged in the period × the rate.
      </p>
    </form>
  );
}
