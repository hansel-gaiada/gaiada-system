"use client";
// SCP-4c (BFF §63.11) — the Boost budget card of a client's current cycle: the agreed amount and how it was agreed (in the portal, or recorded by our team: by whom, when, through which
// channel), what is committed and what remains, a pending proposal if there is one, and the history of the month's proposals and recordings.
//
// FOR THE FOUR APPROVERS (the read's `canRecord`): "Propose to client" (an amount and an optional note; one proposal waits at a time, so the button is off while one does, with the reason),
// "Withdraw proposal" and "Record client's agreement" (an amount, a channel and a note, for an agreement given outside the portal). Anyone else reads the same card with no controls and the
// line that says who can. The page decides nothing: the figures are the server's, lowering below what is committed is refused by the server (`budget_below_committed`, with the figure),
// and every refusal is said in words. The money is the client's own ad budget, never our fees.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { formatDate, formatDateTime } from "@/lib/format";
import { proposeBudget, recordBudget, withdrawProposal, type BoostWrite } from "@/lib/socialBoostsActions";
import {
  AGREED_VIA_LABEL, buildBudgetBody, emptyBudgetForm, formatBoostMoney, proposalStatusLabel, type BoostBudget, type BudgetForm, type BudgetProposal,
} from "@/lib/socialBoosts";
import { CHANNEL_LABEL, CHANNELS, NOTE_MAX, type Refusal } from "@/lib/socialPipeline";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/boosts.css";

type Mode = "propose" | "record" | null;

export function BoostBudgetCard({ cycleId, monthTitle, budget }: { cycleId: string; monthTitle: string; budget: BoostBudget }) {
  const uid = useId();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [form, setForm] = useState<BudgetForm>(emptyBudgetForm());
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { agreed, pending: proposal, canRecord, currency, minorUnit } = budget;
  const money = (n: number | null | undefined) => formatBoostMoney(n, currency, minorUnit);
  const set = (patch: Partial<BudgetForm>) => { setLocal(null); setForm((f) => ({ ...f, ...patch })); };

  function open(next: Mode) { setMode(next); setForm(emptyBudgetForm()); setLocal(null); setRefusal(null); setNotice(null); }

  function done(r: BoostWrite, text: string) {
    if (r.ok) { setMode(null); setNotice(text); setRefusal(null); router.refresh(); return; }
    if (r.refusal.status === 400 && r.refusal.field) setLocal({ field: r.refusal.field, message: r.message });
    else setRefusal({ refusal: r.refusal, message: r.message });
    if (r.refusal.error === "budget_already_decided") router.refresh();
  }

  function submit() {
    if (!mode) return;
    setRefusal(null);
    const built = buildBudgetBody(mode, form, minorUnit);
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); return; }
    start(async () => {
      if (mode === "propose") done(await proposeBudget(cycleId, built.body), "Proposed. The client's signers are asked to agree in the portal.");
      else done(await recordBudget(cycleId, built.body), "Recorded. The agreed budget is now the client's answer.");
    });
  }
  function withdraw(p: BudgetProposal) {
    setRefusal(null);
    setNotice(null);
    start(async () => done(await withdrawProposal(p.id), "The proposal is withdrawn."));
  }

  const err = (f: string) => (local?.field === f ? local.message : null);
  const a11y = (f: string, id: string) => (err(f) ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});
  const why = `${uid}-why`;

  return (
    <section className="scp-budget" aria-labelledby={`${uid}-h`}>
      <h3 className="scp-post__section-title" id={`${uid}-h`} style={{ margin: 0 }}>Boost budget, {monthTitle}</h3>
      <dl className="scp-budget__figures" aria-label="The month's boost budget">
        <div><dt>Agreed</dt><dd>{agreed ? money(agreed.amountMinor) : "Nothing agreed"}</dd></div>
        <div><dt>Committed</dt><dd>{money(budget.committedMinor)}</dd></div>
        <div><dt>Remaining</dt><dd>{money(budget.remainingMinor)}</dd></div>
      </dl>
      <p className="scp-budget__sub">
        {agreed ? (
          <>
            Agreed {agreed.via ? AGREED_VIA_LABEL[agreed.via] : ""}
            {agreed.agreedBy ? `, ${agreed.agreedBy}` : ""}{agreed.agreedAt ? `, ${formatDateTime(agreed.agreedAt)}` : ""}
            {agreed.channel ? ` (${CHANNEL_LABEL[agreed.channel] ?? agreed.channel})` : ""}.
          </>
        ) : (
          "No monthly boost budget is agreed for this client yet, so every boost waits for the client to approve it."
        )}
        {" "}A boost within what remains starts without asking.
      </p>

      {proposal && (
        <div className="scp-budget__pending" role="group" aria-label="A proposal waiting for the client">
          <strong>Waiting for the client: {money(proposal.amountMinor)}</strong>
          <span>Proposed {proposal.by ? `by ${proposal.by}, ` : ""}{formatDateTime(proposal.at)}. The client&apos;s signers agree or decline in the portal.</span>
          {proposal.note && <span>Note: {proposal.note}</span>}
          {canRecord && <div><button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => withdraw(proposal)}>Withdraw proposal</button></div>}
        </div>
      )}

      {notice && <p className="scp-post__banner scp-post__banner--ok" role="status">{notice}</p>}

      {canRecord ? (
        <div className="scp-row__buttons">
          <button
            type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => open("propose")} disabled={pending || proposal !== null}
            aria-describedby={proposal ? why : undefined}
          >
            Propose to client
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open("record")} disabled={pending}>Record client&apos;s agreement</button>
          {proposal && <span id={why} className="scp-field__hint">A proposal is already waiting. Withdraw it to propose another amount.</span>}
        </div>
      ) : (
        <p className="scp-note scp-note--reason" style={{ margin: 0 }}>{PLAN_REFUSAL_REASON.replace("change this", "propose or record the budget")}</p>
      )}

      {canRecord && mode && (
        <form className="scp-budget__form" aria-label={mode === "propose" ? "Propose a boost budget to the client" : "Record the client's agreement"} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <p className="scp-field__hint" style={{ margin: 0 }}>
            {mode === "propose"
              ? "The amount can be higher or lower than the agreement, down to what is already committed. The client agrees or declines in the portal."
              : "The client agreed outside the portal. This sets, raises or lowers the month's budget, down to what is already committed, and replaces any proposal that is waiting."}
          </p>
          <div className="scp-field">
            <label htmlFor={`${uid}-amount`}>Monthly budget ({currency})</label>
            <input id={`${uid}-amount`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.amount} onChange={(e) => set({ amount: e.target.value })} {...a11y("amountMinor", `${uid}-amount`)} />
            {err("amountMinor") && <span id={`${uid}-amount-err`} className="scp-msg scp-msg--error" role="alert">{err("amountMinor")}</span>}
          </div>
          {mode === "record" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-channel`}>How did the client tell you?</label>
              <select id={`${uid}-channel`} className="scp-input" value={form.channel} onChange={(e) => set({ channel: e.target.value })} {...a11y("channel", `${uid}-channel`)}>
                <option value="">Choose…</option>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
              {err("channel") && <span id={`${uid}-channel-err`} className="scp-msg scp-msg--error" role="alert">{err("channel")}</span>}
            </div>
          )}
          <div className="scp-field">
            <label htmlFor={`${uid}-note`}>{mode === "record" ? "Note (required)" : "Note for the client (optional)"}</label>
            <textarea id={`${uid}-note`} className="scp-input" value={form.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} {...a11y("note", `${uid}-note`)} />
            <span className="scp-field__hint">{mode === "record" ? "What the client said, and when." : "The client sees this note beside the amount."} Up to {NOTE_MAX} characters.</span>
            {err("note") && <span id={`${uid}-note-err`} className="scp-msg scp-msg--error" role="alert">{err("note")}</span>}
          </div>
          <div className="scp-row__buttons">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Working…" : mode === "propose" ? "Send proposal" : "Record agreement"}</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open(null)} disabled={pending}>Cancel</button>
          </div>
          {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
        </form>
      )}
      {refusal && !mode && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}

      {budget.history.length > 0 && (
        <div>
          <p className="scp-budget__sub" style={{ fontWeight: 600, margin: "0 0 4px" }}>History this month</p>
          <ul className="scp-budget__history" aria-label="Proposals and agreements, newest first">
            {budget.history.map((h) => (
              <li key={h.id}>
                {proposalStatusLabel(h.status)}: {formatBoostMoney(h.amountMinor, h.currency, h.minorUnit)}
                {h.decidedAt || h.at ? `, ${formatDate(h.decidedAt ?? h.at)}` : ""}
                {h.decidedBy ? `, ${h.decidedBy}` : ""}{h.channel ? ` (${CHANNEL_LABEL[h.channel] ?? h.channel})` : ""}{h.note ? `: ${h.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
