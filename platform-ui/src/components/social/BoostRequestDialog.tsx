"use client";
// SCP-4b (BFF §63.11) — the request dialog of a boost: goal, audience (a note when it is custom), the daily budget and the days, the start date, the reach estimate as the person types
// (debounced) and, from the budget of the cycle the start date falls in, the one line that says what will happen: "Within this month's agreed budget: starts without asking", or
// "Over what remains (IDR x left): the client will be asked to approve it". After the request the answer's `needsClient` decides the confirmation words.
//
// THE PAGE DECIDES NOTHING. The line compares the request's total with the budget read's `remainingMinor`, the same comparison the server makes for `approved` against `requested`; when
// the budget cannot be read the dialog says so and does not claim either. The server checks the role, the body and the post again and decides; every refusal is shown in words, and a 400
// that names a field puts its words beside that input. No ad is bought here: a boost records what the team runs in the network's own tools.
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { RefusalNote } from "@/components/social/PostRefusal";
import { todayIsoInDisplayZone } from "@/lib/format";
import { loadBoostEstimate, loadBudgetForPost, requestBoost, type BoostAnswer } from "@/lib/socialBoostsActions";
import {
  AUDIENCE_NOTE_MAX, BOOST_AUDIENCES, BOOST_AUDIENCE_LABEL, BOOST_GOALS, BOOST_GOAL_LABEL, ESTIMATE_BASIS_WORDS, buildBoostRequest, budgetLine, emptyRequestForm, formatBoostCount,
  formatBoostMoney, plainDate, requestTotal, type BoostEstimate, type BudgetForMonth, type RequestForm,
} from "@/lib/socialBoosts";
import { newActionId, type Refusal } from "@/lib/socialPipeline";
import { minorUnitOf } from "@/lib/contracts";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/boosts.css";

const DEBOUNCE_MS = 400;

export interface BoostRequested { answer: BoostAnswer }

export function BoostRequestDialog({ postId, postTitle, onClose, onRequested }: {
  postId: string; postTitle: string; onClose: () => void;
  /** Called once the server took the request (the page refreshes what it shows). */
  onRequested?: (r: BoostRequested) => void;
}) {
  const uid = useId();
  const [form, setForm] = useState<RequestForm>(() => emptyRequestForm(todayIsoInDisplayZone()));
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const [budget, setBudget] = useState<BudgetForMonth | "loading" | "unknown">("loading");
  const [estimate, setEstimate] = useState<BoostEstimate | "loading" | "unknown" | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [done, setDone] = useState<BoostAnswer | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<RequestForm>) => { setLocal(null); setForm((f) => ({ ...f, ...patch })); };

  // The budget of the cycle the start date falls in: read again whenever the month changes.
  const month = /^\d{4}-\d{2}-\d{2}$/.test(form.startsOn) ? form.startsOn.slice(0, 7) : null;
  useEffect(() => {
    if (!month) { setBudget("unknown"); return; }
    let live = true;
    setBudget("loading");
    void loadBudgetForPost(postId, month).then((r) => { if (live) setBudget(r.ok ? r.budget : "unknown"); }, () => { if (live) setBudget("unknown"); });
    return () => { live = false; };
  }, [postId, month]);

  const known = typeof budget === "object" ? budget : null;
  const currency = known?.currency ?? "IDR";
  const minorUnit = known?.minorUnit ?? minorUnitOf(currency);
  const total = requestTotal(form, minorUnit);

  // The reach estimate: asked for a moment after the person stops typing, and only the newest answer is kept.
  const asked = useRef(0);
  useEffect(() => {
    if (!total) { setEstimate(null); return; }
    const mine = ++asked.current;
    setEstimate("loading");
    const t = setTimeout(() => {
      void loadBoostEstimate(postId, { dailyBudgetMinor: total.dailyMinor, days: total.days, audience: form.audience }).then(
        (e) => { if (asked.current === mine) setEstimate(e ?? "unknown"); }, () => { if (asked.current === mine) setEstimate("unknown"); },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [postId, total?.dailyMinor, total?.days, form.audience]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    setRefusal(null);
    const built = buildBoostRequest(form, { minorUnit, currency: known && known.agreedMinor !== null ? known.currency : null, id: newActionId() });
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); return; }
    start(async () => {
      const r = await requestBoost(postId, built.body);
      if (r.ok) { setDone(r); onRequested?.({ answer: r }); return; }
      if (r.refusal.status === 400 && r.refusal.field) setLocal({ field: r.refusal.field, message: r.message });
      else setRefusal({ refusal: r.refusal, message: r.message });
    });
  }

  const err = (f: string) => (local?.field === f ? local.message : null);
  const a11y = (f: string, id: string) => (err(f) ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});
  const line = total && known ? budgetLine(total.totalMinor, known.remainingMinor, known.currency, known.minorUnit) : null;

  return (
    <Modal
      open onClose={onClose} title={done ? "Boost recorded" : "Boost this post"} size="md"
      footer={
        done ? (
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending}>{pending ? "Working…" : "Request boost"}</button>
          </>
        )
      }
    >
      {done ? (
        <div className="scp-dialog">
          <p className="scp-msg scp-msg--ok" role="status" style={{ margin: 0 }}>
            {done.needsClient
              ? "Requested. It is over this month's agreed budget, so the client has been asked to approve it in the portal. It can start once they agree, or once you record their answer."
              : "Approved within this month's agreed budget. Start it in the network's own ads tool, then press Start here to record it."}
          </p>
          {done.boost && <p className="scp-field__hint" style={{ margin: 0 }}>{formatBoostMoney(done.boost.totalBudgetMinor, done.boost.currency, done.boost.minorUnit)} over {done.boost.days} {done.boost.days === 1 ? "day" : "days"}, from {plainDate(done.boost.startsOn)}.</p>}
        </div>
      ) : (
        <div className="scp-dialog">
          <p className="scp-field__hint" style={{ margin: 0 }}>
            {postTitle ? <>Post: <strong>{postTitle}</strong>. </> : null}This records the boost you run in the network&apos;s own tools; nothing is bought from here.
          </p>
          <div className="scp-boostgrid">
            <div className="scp-field">
              <label htmlFor={`${uid}-goal`}>Goal</label>
              <select id={`${uid}-goal`} className="scp-input" value={form.goal} onChange={(e) => set({ goal: e.target.value })} {...a11y("goal", `${uid}-goal`)}>
                <option value="">Choose…</option>
                {BOOST_GOALS.map((g) => <option key={g} value={g}>{BOOST_GOAL_LABEL[g]}</option>)}
              </select>
              {err("goal") && <span id={`${uid}-goal-err`} className="scp-msg scp-msg--error" role="alert">{err("goal")}</span>}
            </div>
            <div className="scp-field">
              <label htmlFor={`${uid}-aud`}>Audience</label>
              <select id={`${uid}-aud`} className="scp-input" value={form.audience} onChange={(e) => set({ audience: e.target.value })} {...a11y("audience", `${uid}-aud`)}>
                {BOOST_AUDIENCES.map((a) => <option key={a} value={a}>{BOOST_AUDIENCE_LABEL[a]}</option>)}
              </select>
              {err("audience") && <span id={`${uid}-aud-err`} className="scp-msg scp-msg--error" role="alert">{err("audience")}</span>}
            </div>
          </div>
          {form.audience === "custom" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-note`}>Describe the custom audience (required)</label>
              <textarea id={`${uid}-note`} className="scp-input" value={form.audienceNote} maxLength={AUDIENCE_NOTE_MAX} onChange={(e) => set({ audienceNote: e.target.value })} {...a11y("audienceNote", `${uid}-note`)} />
              <span className="scp-field__hint">For example, ages and interests, or the places. Up to {AUDIENCE_NOTE_MAX} characters.</span>
              {err("audienceNote") && <span id={`${uid}-note-err`} className="scp-msg scp-msg--error" role="alert">{err("audienceNote")}</span>}
            </div>
          )}
          <div className="scp-boostgrid">
            <div className="scp-field">
              <label htmlFor={`${uid}-daily`}>Daily budget ({currency})</label>
              <input id={`${uid}-daily`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.dailyBudget} onChange={(e) => set({ dailyBudget: e.target.value })} {...a11y("dailyBudgetMinor", `${uid}-daily`)} />
              {err("dailyBudgetMinor") && <span id={`${uid}-daily-err`} className="scp-msg scp-msg--error" role="alert">{err("dailyBudgetMinor")}</span>}
            </div>
            <div className="scp-field">
              <label htmlFor={`${uid}-days`}>Days</label>
              <input id={`${uid}-days`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.days} onChange={(e) => set({ days: e.target.value })} {...a11y("days", `${uid}-days`)} />
              {err("days") && <span id={`${uid}-days-err`} className="scp-msg scp-msg--error" role="alert">{err("days")}</span>}
            </div>
            <div className="scp-field">
              <label htmlFor={`${uid}-starts`}>Start date</label>
              <input id={`${uid}-starts`} className="scp-input" type="date" value={form.startsOn} onChange={(e) => set({ startsOn: e.target.value })} {...a11y("startsOn", `${uid}-starts`)} />
              {err("startsOn") && <span id={`${uid}-starts-err`} className="scp-msg scp-msg--error" role="alert">{err("startsOn")}</span>}
            </div>
          </div>

          <p className="scp-field__hint" style={{ margin: 0 }} aria-live="polite">
            {total ? <>Total: <strong>{formatBoostMoney(total.totalMinor, currency, minorUnit)}</strong> ({formatBoostMoney(total.dailyMinor, currency, minorUnit)} a day for {total.days} {total.days === 1 ? "day" : "days"}).</> : "Fill in the daily budget and the days to see the total."}
          </p>
          <p className="scp-boostline" data-within={line ? String(line.within) : "unknown"} aria-live="polite">
            {!total ? "Within this month's budget, or over it, shows once the total is known."
              : budget === "loading" ? "Reading this month's budget…"
                : budget === "unknown" ? "This month's budget could not be read, so this page cannot say whether the client will be asked. The server decides when you request."
                  : line?.text}
          </p>
          {total && (
            <p className="scp-field__hint" style={{ margin: 0 }} aria-live="polite">
              {estimate === "loading" || estimate === null ? "Estimating the reach…"
                : estimate === "unknown" ? "The reach estimate could not be read."
                  : estimate.basis === "none" ? ESTIMATE_BASIS_WORDS.none
                    : <>Estimated reach: <strong>{formatBoostCount(estimate.low)} to {formatBoostCount(estimate.high)}</strong> people. {ESTIMATE_BASIS_WORDS[estimate.basis]}</>}
            </p>
          )}
          {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
        </div>
      )}
    </Modal>
  );
}
