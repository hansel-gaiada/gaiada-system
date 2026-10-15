"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { clearRevenuePlanMonth, setRevenuePlanMonth } from "@/lib/revenuePlanActions";
import { minorToMajor } from "@/lib/revenuePlan";
import "@/components/forms/forms.css";
import "../deptkpis/deptKpis.css";
import "./revenuePlan.css";

/**
 * Set or clear one month's plan (BFF §40.6.4). Offered to whoever holds `company.manage` (or is elevated); the server decides, and its
 * refusal is shown in words, because a `manager` holds `company.manage` and is still refused (only `company_admin` approves). The
 * amount is typed in major units, such as 200000000 for IDR 200 million; the action converts it with the currency's own decimals.
 */
export function RevenuePlanEditor({
  month, label, currency, minorUnit, amountMinor, note,
}: {
  month: string;
  label: string;
  currency: string;
  minorUnit: number;
  amountMinor: number | null;
  note: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const current = amountMinor === null ? "" : minorToMajor(amountMinor, minorUnit).toFixed(minorUnit);

  const done = (res: { ok: boolean; error?: string; field?: string }, failure: string) => {
    if (res.ok) {
      setMsg(null);
      setField(undefined);
      setOpen(false);
      router.refresh();
    } else {
      setMsg(res.error ?? failure);
      setField(res.field);
    }
  };

  const onSave = (formData: FormData) => {
    startTransition(async () => {
      done(await setRevenuePlanMonth(month, String(formData.get("amount") ?? ""), String(formData.get("note") ?? "")), "Could not save the plan.");
    });
  };
  const onClear = () => {
    startTransition(async () => {
      done(await clearRevenuePlanMonth(month), "Could not clear the plan.");
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)} aria-label={`${amountMinor === null ? "Set" : "Edit"} the plan for ${label}`}>
        {amountMinor === null ? "Set" : "Edit"}
      </button>
    );
  }

  return (
    <form action={onSave} className="dk-form rp-form" aria-label={`Plan for ${label}`}>
      <Field name="amount" label={`Plan for ${label} (${currency})`} type="text" required defaultValue={current}
        hint={minorUnit === 0 ? "A whole amount, e.g. 200000000" : `At most ${minorUnit} decimals`} error={field === "amount" ? msg ?? undefined : undefined} />
      <Field name="note" label="Note (optional)" type="text" defaultValue={note ?? ""} error={field === "note" ? msg ?? undefined : undefined} />
      <div className="dk-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        {amountMinor !== null && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={onClear} aria-label={`Clear the plan for ${label}`}>Clear</button>
        )}
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => { setOpen(false); setMsg(null); setField(undefined); }}>Cancel</button>
        {msg && field !== "amount" && field !== "note" && <span role="alert" className="dk-msg dk-msg--bad">{msg}</span>}
      </div>
    </form>
  );
}
