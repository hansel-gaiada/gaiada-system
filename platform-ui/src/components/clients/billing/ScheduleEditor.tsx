"use client";
import { useActionState, useId, useMemo, useState } from "react";
import { addScheduleAfterSigningAction, saveScheduleAction, type BillingActionState } from "@/lib/contractsActions";
import {
  AFTER_SIGNING_WARNING, MAX_INSTALMENTS, ON_SIGNING, presetAllOnSigning, presetFiftyFifty, presetMonthly,
  rowsFromSchedule, scheduleLine, validateScheduleRows, valueToMinor, formatMinor, minorUnitOf, toMinor,
  type Contract, type ContractSchedule, type ScheduleDraftRow,
} from "@/lib/contracts";
import { formatDate } from "@/lib/format";
import "./billing.css";

// DW-10f-2b (BFF §61.4, §61.4a, §61.9) — the contract's PAYMENT SCHEDULE editor.
//
// Two modes, one component:
//   "draft"          a draft agreement or amendment (the Edit panel). Save sends `PUT …/schedule` through `saveScheduleAction`; the
//                    schedule may be saved while it does not add up yet, and Send stays disabled on the row until it does.
//   "after-signing"  DW-D49: a SIGNED agreement with a value and no schedule. The same rows, then a CONFIRM step that shows them and
//                    says what the addition is, and only then `POST …/schedule/after-signing` through `addScheduleAfterSigningAction`.
//
// ── THE ROWS ARE TEXT, THE SUMS ARE EXACT ───────────────────────────────────────────────────────────
// An amount is a decimal string, from the preset or typed, and goes to the server as that string. Every sum is BigInt minor units
// (`scheduleLine`), so "adds up" is never a float comparison. The presets are `lib/contracts.ts`'s pure functions, pinned by its
// tests: even split rounded down, the remainder on the first row, month ends clamped. After a preset the rows are ordinary rows.
//
// ── THE PRESETS READ THE SAVED VALUE ────────────────────────────────────────────────────────────────
// The value and currency are the contract's SAVED ones (this panel sits below the form that edits them). Change the value, save the
// form, and the presets and the live line follow it; the line says "short" or "over" until they agree.
//
// The browser's own checks (`validateScheduleRows`) run in the action too, and the server repeats every one. Nothing here decides
// that a schedule is valid: the server does, and its refusal is shown in words.

type Row = ScheduleDraftRow & { key: number };
let nextKey = 1;
const withKey = (rows: ScheduleDraftRow[]): Row[] => rows.map((r) => ({ ...r, key: nextKey++ }));
const bare = (rows: Row[]): ScheduleDraftRow[] => rows.map(({ label, amount, due }) => ({ label, amount, due }));

function Msg({ state }: { state: BillingActionState | null }) {
  if (!state) return null;
  if (!state.ok && state.error) return <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>;
  if (state.ok && state.notice) return <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>;
  return null;
}

export function ScheduleEditor({
  clientId, contract, schedule, mode, onDone,
}: {
  clientId: string;
  contract: Pick<Contract, "id" | "title" | "value" | "currency" | "startsOn" | "endsOn">;
  /** The saved schedule (the detail read), for the draft's starting rows. A signed contract has none (that is why it is addable). */
  schedule?: ContractSchedule | null;
  mode: "draft" | "after-signing";
  onDone?: () => void;
}) {
  const after = mode === "after-signing";
  const currency = contract.currency;
  const [rows, setRows] = useState<Row[]>(() => withKey(rowsFromSchedule(schedule)));
  const [balanceDue, setBalanceDue] = useState(contract.endsOn ?? "");
  const [months, setMonths] = useState("3");
  const [firstDue, setFirstDue] = useState(contract.startsOn ?? "");
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [state, action, pending] = useActionState<BillingActionState | null, FormData>(after ? addScheduleAfterSigningAction : saveScheduleAction, null);
  // An answer describes the rows as they were when sent: once the person edits again it is stale, so it is put away.
  const [dismissed, setDismissed] = useState<BillingActionState | null>(null);
  const id = useId();

  const valued = (valueToMinor(contract.value, currency) ?? BigInt(0)) > BigInt(0);
  const line = useMemo(() => scheduleLine(bare(rows), contract.value, currency), [rows, contract.value, currency]);
  const monthsN = Number(months);
  const monthsOk = Number.isInteger(monthsN) && monthsN >= 1 && monthsN <= MAX_INSTALMENTS;
  const fieldError = state && !state.ok ? state.error : undefined;

  const touched = () => { setReviewing(false); setDismissed(state); };
  const replace = (next: ScheduleDraftRow[]) => { setRows(withKey(next)); touched(); setReviewError(null); };
  const patch = (key: number, p: Partial<ScheduleDraftRow>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r))); touched(); };
  const remove = (key: number) => { setRows((rs) => rs.filter((r) => r.key !== key)); touched(); };
  const move = (i: number, by: -1 | 1) => {
    setRows((rs) => {
      const j = i + by;
      if (j < 0 || j >= rs.length) return rs;
      const copy = [...rs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
    touched();
  };
  const add = () => { setRows((rs) => [...rs, ...withKey([{ label: "", amount: "", due: "" }])]); touched(); };

  // The review step of an addition: the browser's checks, and the rule it cannot be added until it adds up.
  function review() {
    const bad = validateScheduleRows(bare(rows), currency, { requireOne: true });
    if (bad) return setReviewError(bad.message);
    if (!line.addsUp) return setReviewError(line.kind === "no_value" ? line.text : `The instalments must add up exactly to the contract's value. ${line.text}`);
    setReviewError(null);
    setReviewing(true);
  }

  const plain = bare(rows);
  const minor = minorUnitOf(currency);

  return (
    <section className="bl-sched" aria-label={after ? "Add a payment schedule" : "Payment schedule"}>
      <h5 className="bl-sched__title">{after ? "Add a payment schedule" : "Payment schedule"}</h5>
      {after && <p className="bl-form__hint">{AFTER_SIGNING_WARNING}</p>}
      <p className="bl-form__hint">
        {valued
          ? <>The contract&apos;s saved value is <strong>{formatMinor(valueToMinor(contract.value, currency) ?? BigInt(0), currency)}</strong>. The instalments must add up to it exactly{after ? "" : " before the contract can be sent"}.</>
          : "This contract has no value yet, so it carries no payment schedule. Set a value and save the contract first; the presets then work from it."}
      </p>

      {!reviewing && (
        <>
          <div className="bl-sched__presets" role="group" aria-label="Presets">
            <span className="bl-sched__presetlabel">Start from a preset (replaces the rows below)</span>
            <div className="bl-sched__presetrow">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!valued || pending} onClick={() => replace(presetAllOnSigning(contract.value, currency))}>
                All on signing
              </button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!valued || pending} onClick={() => replace(presetFiftyFifty(contract.value, currency, balanceDue))}>
                50/50
              </button>
              <label className="bl-sched__inline">
                <span>Balance due on</span>
                <input type="date" value={balanceDue} onChange={(e) => setBalanceDue(e.target.value)} disabled={pending} />
              </label>
            </div>
            <div className="bl-sched__presetrow">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!valued || !monthsOk || pending} onClick={() => replace(presetMonthly(contract.value, currency, monthsN, firstDue))}>
                Monthly × N
              </button>
              <label className="bl-sched__inline">
                <span>Months (N)</span>
                <input type="number" min={1} max={MAX_INSTALMENTS} step={1} value={months} onChange={(e) => setMonths(e.target.value)} disabled={pending} />
              </label>
              <label className="bl-sched__inline">
                <span>First due on</span>
                <input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} disabled={pending} />
              </label>
            </div>
          </div>

          {rows.length > 0 && (
            <ol className="bl-sched__rows" aria-label="Instalments">
              {rows.map((r, i) => {
                const n = i + 1;
                const isSigning = r.due === ON_SIGNING;
                return (
                  <li key={r.key} className="bl-sched__row">
                    <label className="bl-sched__cell bl-sched__cell--label">
                      <span>Label</span>
                      <input aria-label={`Label, instalment ${n}`} value={r.label} maxLength={120} onChange={(e) => patch(r.key, { label: e.target.value })} disabled={pending} />
                    </label>
                    <label className="bl-sched__cell">
                      <span>Amount ({currency.toUpperCase()})</span>
                      <input aria-label={`Amount, instalment ${n}`} inputMode="decimal" value={r.amount} onChange={(e) => patch(r.key, { amount: e.target.value })} disabled={pending} />
                    </label>
                    <label className="bl-sched__cell">
                      <span>Due</span>
                      <select
                        aria-label={`Due, instalment ${n}`}
                        value={isSigning ? ON_SIGNING : "date"}
                        onChange={(e) => patch(r.key, { due: e.target.value === ON_SIGNING ? ON_SIGNING : "" })}
                        disabled={pending}
                      >
                        <option value={ON_SIGNING}>On signing</option>
                        <option value="date">On a date</option>
                      </select>
                    </label>
                    {!isSigning && (
                      <label className="bl-sched__cell">
                        <span>Due date</span>
                        <input type="date" aria-label={`Due date, instalment ${n}`} value={r.due} onChange={(e) => patch(r.key, { due: e.target.value })} disabled={pending} />
                      </label>
                    )}
                    <span className="bl-sched__rowactions">
                      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Move instalment ${n} up`} disabled={i === 0 || pending} onClick={() => move(i, -1)}>Up</button>
                      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Move instalment ${n} down`} disabled={i === rows.length - 1 || pending} onClick={() => move(i, 1)}>Down</button>
                      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Remove instalment ${n}`} disabled={pending} onClick={() => remove(r.key)}>Remove</button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="bl-sched__addrow">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={add} disabled={rows.length >= MAX_INSTALMENTS || pending}>
              Add an instalment
            </button>
          </div>
        </>
      )}

      {/* The live line: from the rows as typed, in exact minor units. Polite, so it does not shout on every keystroke. */}
      <p className={`bl-sched__line bl-sched__line--${line.kind}`} role="status" aria-live="polite" id={`${id}-line`}>
        {line.text}
      </p>

      {reviewError && <p className="bl-msg bl-msg--error" role="alert">{reviewError}</p>}

      {after && reviewing ? (
        <form action={action} className="bl-form" aria-label="Confirm adding the payment schedule">
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="contractId" value={contract.id} />
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="instalments" value={JSON.stringify(plain)} />
          <p className="bl-sched__warn" id={`${id}-warn`}>{AFTER_SIGNING_WARNING}</p>
          <table className="bl-sched__table" aria-label="The schedule to be added">
            <thead><tr><th scope="col">#</th><th scope="col">Instalment</th><th scope="col">Due</th><th scope="col" className="bl-sched__num">Amount</th></tr></thead>
            <tbody>
              {plain.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.label.trim()}</td>
                  <td>{r.due === ON_SIGNING ? "On signing" : `Due ${formatDate(r.due)}`}</td>
                  <td className="bl-sched__num">{formatMinor(toMinor(r.amount, minor) ?? BigInt(0), currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={3}>Total</th><td className="bl-sched__num">{formatMinor(valueToMinor(contract.value, currency) ?? BigInt(0), currency)}</td></tr></tfoot>
          </table>
          {fieldError && <p className="bl-msg bl-msg--error" role="alert">{fieldError}</p>}
          <div className="bl-form__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} aria-describedby={`${id}-warn`}>
              {pending ? "Adding…" : "Add the payment schedule"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setReviewing(false)} disabled={pending}>Back to the rows</button>
          </div>
        </form>
      ) : (
        <form action={action} aria-label={after ? "Add the payment schedule" : "Save the payment schedule"}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="contractId" value={contract.id} />
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="instalments" value={JSON.stringify(plain)} />
          <div className="bl-form__actions">
            {after ? (
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={review} disabled={pending || rows.length === 0}>
                Review the schedule
              </button>
            ) : (
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
                {pending ? "Saving…" : "Save schedule"}
              </button>
            )}
            {onDone && (
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onDone} disabled={pending}>
                {after ? "Cancel" : "Close"}
              </button>
            )}
          </div>
        </form>
      )}
      {!after && state !== dismissed && <Msg state={state} />}
    </section>
  );
}
