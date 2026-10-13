"use client";
// PV5-04b (PV-D35) — the service-line picker on the staff invoice page. An invoice number carries a code for its service line,
// so staff choose one BEFORE issuing. When every project behind the invoice maps to one line through its department the page
// already names it as the default and Issue works without a choice; otherwise a missing line is the `NO_SERVICE_LINE` blocker
// above and this is where it is cleared (the blocker's link points here).
//
// STAFF ONLY: the page is the staff invoice page, and the code and its meaning are never shown to a client.
import Link from "next/link";
import { useActionState } from "react";
import { setServiceLineAction, type InvoiceActionState } from "@/lib/invoiceActions";
import type { ServiceLine } from "@/lib/billingNumbering";
import { BILLING_PROFILE_PATH } from "@/lib/billingProfile";
import "@/components/billing/billing-screens.css";

export function ServiceLinePicker({ invoiceId, lines, chosenKey, defaultKey }: {
  invoiceId: string;
  /** The company's lines. */
  lines: ServiceLine[];
  /** What staff chose on this invoice, or null. */
  chosenKey: string | null;
  /** The line the invoice would default to (all its projects map to one), or null. */
  defaultKey: string | null;
}) {
  const bound = setServiceLineAction.bind(null, invoiceId);
  const [state, formAction, pending] = useActionState<InvoiceActionState | null, FormData>(bound, null);
  const nameOf = (key: string | null) => (key ? lines.find((l) => l.key === key)?.name ?? key : null);
  const usable = lines.filter((l) => l.active || l.key === chosenKey);

  if (lines.length === 0) {
    return (
      <p className="bs-note">
        This company has no service lines yet, so this invoice cannot be numbered.{" "}
        <Link className="bs-link" href={`${BILLING_PROFILE_PATH}#service-lines`}>Add service lines</Link>
      </p>
    );
  }
  return (
    <form action={formAction} className="bs-picker" aria-label="Service line">
      <div className="bs-picker__row">
        <div className="bs-field">
          <label className="bs-field__label" htmlFor="service-line-select">Service line</label>
          <select id="service-line-select" name="serviceLineKey" defaultValue={chosenKey ?? ""} disabled={pending} aria-describedby="service-line-hint">
            <option value="">{defaultKey ? `Default: ${nameOf(defaultKey)}` : "Choose a service line"}</option>
            {usable.map((l) => <option key={l.key} value={l.key}>{l.name}{l.active ? "" : " (switched off)"}</option>)}
          </select>
        </div>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </div>
      <span className="bs-field__hint" id="service-line-hint">
        {chosenKey
          ? `Chosen: ${nameOf(chosenKey)}.`
          : defaultKey
            ? `Not chosen. It will be issued under ${nameOf(defaultKey)}, which every project on this invoice belongs to.`
            : "Not chosen, and no default applies. Pick one before issuing."}{" "}
        It sets the code in the invoice number, which only staff can decode.
      </span>
      {state?.error && <p className="bs-error" role="alert">{state.error}</p>}
      {state?.ok && <p className="bs-ok" role="status">Saved.</p>}
    </form>
  );
}
