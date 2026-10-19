"use client";
import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { createInvoiceFromScheduleAction, type ScheduleDraftState } from "@/lib/invoiceActions";
import {
  contractHref, contractName, defaultSelection, instalmentName, isTickable, summariseSelection, unavailableWords,
  type BillableInstalment,
} from "@/lib/contractBilling";
import { dueWords, formatAmountNumber } from "@/lib/contracts";
import { formatDate } from "@/lib/format";
import "./billing-screens.css";

// DW-10f-3b (BFF §61.5, §61.9, DW-D48) — the checklist of instalments to invoice, and "Create from the schedule".
//
// Every `due` row is ticked when the list opens; an `upcoming` row is shown with its date and cannot be ticked (it is not due by
// the "Due up to" date; move that date forward to invoice ahead); an `invoicing` row is already on a draft and links to it. The
// draft is made from the instalments, never mixed with hours (DW-D48): the hourly form is a separate, explicit exception on the page.
//
// What is ticked and what the total is come from the server's own rows (`summariseSelection`, exact in minor units). Whether a tick
// is still billable is the server's call at the click: every refusal comes back as a sentence, and for a lost race the rows it names
// are listed with the reason. On success the action opens the new draft.
export function InstalmentPicker({
  clientId, dueBy, items,
}: {
  clientId: string;
  dueBy: string;
  items: BillableInstalment[];
}) {
  const [selected, setSelected] = useState<string[]>(() => defaultSelection(items));
  const [state, action, pending] = useActionState<ScheduleDraftState | null, FormData>(createInvoiceFromScheduleAction, null);
  const taxId = useId();
  const sum = summariseSelection(items, selected);
  const labelOf = new Map(items.map((i) => [i.instalmentId, `${instalmentName(i)}, ${contractName(i.contract)}`]));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const blockedReason = sum.count === 0
    ? "Tick at least one instalment that is due."
    : sum.mixed
      ? "The ticked instalments are in more than one currency. Make one invoice per currency."
      : null;
  const anyTickable = items.some(isTickable);

  return (
    <form action={action} className="bs-form" aria-label="Create an invoice from the payment schedule">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="dueBy" value={dueBy} />
      <table className="bs-sched" aria-label="Billable instalments">
        <thead>
          <tr>
            <th scope="col"><span className="bs-sr-only">Include</span></th>
            <th scope="col">Instalment</th>
            <th scope="col">Agreement</th>
            <th scope="col">Due</th>
            <th scope="col" className="bs-sched__num">Amount</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const tick = isTickable(i);
            const id = `inst-${i.instalmentId}`;
            return (
              <tr key={i.instalmentId} data-state={i.state}>
                <td>
                  {tick ? (
                    <input
                      id={id} type="checkbox" name="instalmentId" value={i.instalmentId}
                      checked={selected.includes(i.instalmentId)} onChange={() => toggle(i.instalmentId)} disabled={pending}
                      aria-label={`Invoice ${instalmentName(i)}, ${contractName(i.contract)}`}
                    />
                  ) : (
                    <input type="checkbox" disabled aria-label={`${instalmentName(i)}, ${contractName(i.contract)}: ${i.state === "upcoming" ? "not due yet" : "already on a draft invoice"}`} />
                  )}
                </td>
                <td><label htmlFor={tick ? id : undefined}>{instalmentName(i)}</label></td>
                <td>
                  <Link className="bs-link" href={contractHref(i.client.id, i.contract.id)}>{contractName(i.contract)}</Link>
                  {i.contract.kind === "amendment" ? <span className="bs-note"> · Amendment</span> : null}
                </td>
                <td>{dueWords(i.due, formatDate)}</td>
                <td className="bs-sched__num">{formatAmountNumber(i.amount, i.currency)}</td>
                <td>
                  {i.state === "due" ? "Due: ready to invoice"
                    : i.state === "upcoming" ? `Upcoming, ${formatDate(i.due.on)}`
                    : i.state === "invoicing" && i.invoice ? <Link className="bs-link" href={`/invoices/${encodeURIComponent(i.invoice.id)}`}>On a draft invoice</Link>
                    : i.state}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {anyTickable ? (
        <div className="bs-grid">
          <div className="bs-field">
            <label className="bs-field__label" htmlFor={taxId}>Tax code (optional)</label>
            <input id={taxId} name="taxCode" maxLength={32} autoComplete="off" disabled={pending} aria-describedby={`${taxId}-hint`} />
            <span className="bs-field__hint" id={`${taxId}-hint`}>For example PPN. Leave blank for an invoice with no tax.</span>
          </div>
        </div>
      ) : null}

      {state?.error && (
        <div role="alert" className="bs-error">
          <p className="bs-error__lead">{state.error}</p>
          {state.items && state.items.length > 0 && (
            <ul>
              {state.items.map((it) => (
                <li key={it.instalmentId}>
                  {labelOf.get(it.instalmentId) ?? "An instalment"} {unavailableWords(it.reason)}.
                  {it.invoiceId ? <> <Link className="bs-link" href={`/invoices/${encodeURIComponent(it.invoiceId)}`}>Open that invoice</Link></> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="bs-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || Boolean(blockedReason)} aria-describedby={blockedReason ? `${taxId}-why` : undefined}>
          {pending ? "Creating…" : "Create from the schedule"}
        </button>
        <span className="bs-note" role="status" aria-live="polite">
          {sum.count > 0 && !sum.mixed ? `${sum.count} ${sum.count === 1 ? "instalment" : "instalments"} ticked, ${sum.totalText}.` : ""}
        </span>
        {blockedReason && <span className="bs-note" id={`${taxId}-why`}>{blockedReason}</span>}
      </div>
    </form>
  );
}
