"use client";
// Loan request form (wave E). Same disclosure pattern as components/hr/LeaveForm.tsx: a button that
// opens an inline card, a server action, router.refresh() on success.
//
// It shows a LIVE estimate of the monthly payment and total cost before submitting, because the
// number that matters to the requester is not the principal — it is what leaves their pay each month.
// The estimate is deliberately labelled an estimate: the authoritative schedule is frozen server-side
// at APPROVAL, anchored on the approval date, so a request that sits in the inbox for three weeks
// gets a later first-due date than the one previewed here.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import { money } from "@/lib/loans";
import type { LoanResult } from "@/lib/loanActions";
import "@/components/forms/forms.css";

/** Mirrors the server's annuity math closely enough for an estimate (see loan-schedule.ts). */
function estimate(principal: number, ratePct: number, months: number): { monthly: number; total: number } | null {
  if (!(principal > 0) || !(months >= 1)) return null;
  const i = ratePct / 100 / 12;
  const monthly = i > 0 ? (principal * i) / (1 - Math.pow(1 + i, -months)) : principal / months;
  return { monthly: Math.round(monthly), total: Math.round(monthly * months) };
}

export function LoanRequestForm({ request, companyId, currency = "IDR", subjectOptions }: {
  request: (formData: FormData) => Promise<LoanResult>;
  companyId: string;
  currency?: string;
  /** Non-empty only for hr.manage holders, who may raise a request on someone else's behalf. */
  subjectOptions?: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [est, setEst] = useState<{ monthly: number; total: number; months: number } | null>(null);

  // `Field` is uncontrolled (defaultValue only), so the estimate is recomputed from the form itself
  // on any change rather than from per-input state — one handler, and it cannot drift from what will
  // actually be submitted.
  const recompute = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const months = Number(fd.get("termMonths"));
    const e = estimate(Number(fd.get("principalAmount")), Number(fd.get("annualInterestRate") ?? 0), months);
    setEst(e ? { ...e, months } : null);
  };

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await request(formData);
      if (res.ok) {
        setMsg(null);
        setOpen(false);
        setEst(null);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't submit the request.");
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        Request a loan
      </button>
    );
  }

  return (
    <Card title="Request a loan" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid" onChange={(e) => recompute(e.currentTarget)}>
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="currency" value={currency} />
        {subjectOptions && subjectOptions.length > 0 && (
          <Field name="subjectUserId" label="For" type="select" optionItems={subjectOptions} placeholder="Myself" />
        )}
        <Field name="principalAmount" label={`Amount (${currency})`} type="number" required />
        <Field name="termMonths" label="Term (months)" type="number" required defaultValue={12} />
        <Field
          name="annualInterestRate" label="Annual interest %" type="number" defaultValue={0}
          hint="Leave at 0 for an interest-free staff loan."
        />
        <Field name="purpose" label="Purpose" type="textarea" />

        {est && (
          <p style={{
            margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-ink-50)",
          }}>
            Estimated <strong style={{ color: "var(--erp-ink)" }}>{money(est.monthly, currency)}</strong> per month
            for {est.months} months — {money(est.total, currency)} in total.
            {" "}Your first instalment would fall on the 1st of the month after approval. The exact schedule is set when
            the request is approved.
          </p>
        )}

        {msg && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Submitting…" : "Submit request"}
          </button>
          <button type="button" className="lux-btn lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
