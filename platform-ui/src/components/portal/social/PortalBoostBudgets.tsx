"use client";
// SCP-4b (BFF §63.11 "The portal's approvals") — the "Boost budgets" section of `/portal/approvals`: the client's own money for boosting their posts.
//
// WHAT IT SHOWS, from `GET portal/social/spend`: a month's budget the team proposed (the month, the amount, what is already agreed and committed, the team's note), each boost that is over
// the month's agreed budget and waits for the client (the post's title and thumbnail, the total, the days, the start date, what remains of the month), and the client's history.
//
// WHO DECIDES. Only a contact with signing capability on the account (`canDecide`), because agreeing commits the client's money. Everyone else sees the same items and one line that says
// only a signer can decide; the server answers 403 `view_only` to a viewer who tries anyway, and that is said in words too. Each decision may carry an optional note. A replay of the
// same decision answers `{alreadyDecided: true}` and is shown as already done, never as a second decision.
//
// WHAT IT NEVER SHOWS: our fees (the server sends none, and none is invented here), a staff status or a staff name. The section is drawn by the page only when there is an item or a history.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideBoost, decideBoostBudget } from "@/lib/portalSpendActions";
import { monthLabel, portalSocialFileHref, whenLabel } from "@/lib/portalSocial";
import { PORTAL_VIEWER_LINE, daysText, formatBoostMoney, plainDate, type PortalBoostItem, type PortalBudgetItem, type PortalSpend } from "@/lib/socialBoosts";
import { NOTE_MAX } from "@/lib/socialPipeline";
import "./portalSocial.css";
import "./portalBoosts.css";

interface Settled { id: string; text: string }
const HISTORY_STATUS: Readonly<Record<string, string>> = { agreed: "Agreed", declined: "Declined", approved: "Approved", superseded: "Replaced by a later agreement" };

export function PortalBoostBudgets({ spend, tenant }: { spend: PortalSpend; tenant: string }) {
  const uid = useId();
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settled, setSettled] = useState<Settled[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const gone = new Set(settled.map((s) => s.id));
  const budgets = spend.budgets.filter((b) => !gone.has(b.proposalId));
  const boosts = spend.boosts.filter((b) => !gone.has(b.boostId));
  const waiting = budgets.length + boosts.length;

  function decide(id: string, label: string, run: () => ReturnType<typeof decideBoost>) {
    setErrors((e) => ({ ...e, [id]: "" }));
    setBusy(id);
    start(async () => {
      const r = await run();
      setBusy(null);
      if (!r.ok) { setErrors((e) => ({ ...e, [id]: r.error ?? "That did not go through. Try again." })); return; }
      setSettled((s) => [...s, { id, text: r.alreadyDecided ? `${label}: this was already decided, so nothing changed.` : `${label}: done.` }]);
      router.refresh();
    });
  }

  const noteField = (id: string, what: string) => (
    <div className="pb-note">
      <label htmlFor={`${uid}-${id}`}>Note to the team (optional)</label>
      <textarea id={`${uid}-${id}`} className="cp-textarea" rows={3} value={notes[id] ?? ""} maxLength={NOTE_MAX} onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))} aria-label={`Note to the team about ${what} (optional)`} />
    </div>
  );

  return (
    <section className="pb-section" aria-labelledby={`${uid}-h`}>
      <h2 className="pb-h" id={`${uid}-h`}>Boost budgets</h2>
      <p className="pb-lead">
        A boost is a paid push of one of your posts on the network. Each month has a budget you agree with us. A boost within it starts without asking; one over it waits here for your approval.
      </p>

      {settled.length > 0 && (
        <ul className="pb-settled" role="status" aria-label="Decisions just made">{settled.map((s) => <li key={s.id}>{s.text}</li>)}</ul>
      )}

      {waiting > 0 && !spend.canDecide && <p className="pb-viewer" role="note">{PORTAL_VIEWER_LINE}</p>}

      {budgets.length > 0 && (
        <ul className="pb-list" aria-label="Budgets waiting for you">
          {budgets.map((b: PortalBudgetItem) => {
            const money = (n: number | null) => formatBoostMoney(n, b.currency, b.minorUnit);
            const title = `Boost budget for ${monthLabel(b.month)}`;
            return (
              <li key={b.proposalId} className="pb-item" data-proposal-id={b.proposalId}>
                <div className="pb-item__main">
                  <p className="pb-item__title">{title}</p>
                  <p className="pb-item__line">We propose <strong>{money(b.amountMinor)}</strong> for the month.</p>
                  <p className="pb-item__sub">
                    {b.agreedMinor === null ? "Nothing is agreed for this month yet." : `Agreed so far: ${money(b.agreedMinor)}.`} Already committed to boosts: {money(b.committedMinor)}.
                    {b.requestedAt ? ` Asked ${whenLabel(b.requestedAt)}.` : ""}
                  </p>
                  {b.note && <p className="pb-item__sub">Our note: {b.note}</p>}
                </div>
                {spend.canDecide && (
                  <div className="pb-item__decide">
                    {noteField(b.proposalId, title)}
                    <div className="pb-buttons">
                      <button type="button" className="lux-btn lux-btn--solid ps-btn" disabled={pending} aria-label={`Agree to the ${title}`}
                        onClick={() => decide(b.proposalId, `${title}, agreed`, () => decideBoostBudget(b.proposalId, "agree", notes[b.proposalId]))}>
                        {busy === b.proposalId ? "Working…" : "Agree"}
                      </button>
                      <button type="button" className="lux-btn ps-btn" disabled={pending} aria-label={`Decline the ${title}`}
                        onClick={() => decide(b.proposalId, `${title}, declined`, () => decideBoostBudget(b.proposalId, "decline", notes[b.proposalId]))}>
                        Decline
                      </button>
                    </div>
                    {errors[b.proposalId] && <p className="pb-error" role="alert">{errors[b.proposalId]}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {boosts.length > 0 && (
        <ul className="pb-list" aria-label="Boosts waiting for you">
          {boosts.map((b: PortalBoostItem) => {
            const money = (n: number) => formatBoostMoney(n, b.currency, b.minorUnit);
            const label = `the boost of ${b.postTitle || "your post"}`;
            return (
              <li key={b.boostId} className="pb-item" data-boost-id={b.boostId}>
                {b.thumbFileId && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="pb-thumb" src={portalSocialFileHref(tenant, b.thumbFileId)} alt={`Your post: ${b.postTitle}`} loading="lazy" width={72} height={72} />
                )}
                <div className="pb-item__main">
                  <p className="pb-item__title">{b.postTitle || "Your post"}</p>
                  <p className="pb-item__line">A boost of <strong>{money(b.totalBudgetMinor)}</strong> over {daysText(b.days)}, starting {plainDate(b.startsOn)}.</p>
                  <p className="pb-item__sub">It is over this month&apos;s agreed budget. What is left of the month: {money(b.remainingMinor)}.</p>
                </div>
                {spend.canDecide && (
                  <div className="pb-item__decide">
                    {noteField(b.boostId, label)}
                    <div className="pb-buttons">
                      <button type="button" className="lux-btn lux-btn--solid ps-btn" disabled={pending} aria-label={`Approve ${label}`}
                        onClick={() => decide(b.boostId, `${b.postTitle || "The boost"}, approved`, () => decideBoost(b.boostId, "approve", notes[b.boostId]))}>
                        {busy === b.boostId ? "Working…" : "Approve"}
                      </button>
                      <button type="button" className="lux-btn ps-btn" disabled={pending} aria-label={`Decline ${label}`}
                        onClick={() => decide(b.boostId, `${b.postTitle || "The boost"}, declined`, () => decideBoost(b.boostId, "decline", notes[b.boostId]))}>
                        Decline
                      </button>
                    </div>
                    {errors[b.boostId] && <p className="pb-error" role="alert">{errors[b.boostId]}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {waiting === 0 && settled.length === 0 && <p className="pb-calm">Nothing is waiting for your decision on boost budgets.</p>}

      {spend.history.length > 0 && (
        <div className="pb-history">
          <h3 className="pb-h3">Past decisions</h3>
          <ul className="pb-history__list" aria-label="Past boost decisions">
            {spend.history.map((h) => (
              <li key={`${h.kind}-${h.id}`}>
                <span>{h.title}</span>
                <span>{HISTORY_STATUS[h.status] ?? h.status}{h.amountMinor !== null ? `: ${formatBoostMoney(h.amountMinor, h.currency, h.minorUnit)}` : ""}</span>
                {h.decidedAt && <span>{whenLabel(h.decidedAt)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
