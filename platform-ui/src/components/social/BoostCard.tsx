"use client";
// SCP-4b (BFF §63.11) — one boost as a card: its status in words (and SIMULATED on a simulated one), the budget, the dates, the results, and the actions its status and the person allow.
//
// THE ACTIONS ARE THE FIXTURE'S. What exists from a status (`scpBoostActionsFrom`) and which of them are the person's (`boostOffers`): Cancel (requested, approved), Start (approved), Stop
// (running: the spend is required, the paid reach and clicks optional), Complete (running or stopped: the spend and the paid reach are required, clicks optional) are the client's
// officer's and the HoD's and GM's; "Record client's approval" and "Record client's decline" (requested: a channel and a note, both required) are one of the four approvers'. The
// `canRun` and `canRecord` the page passes are MIRRORS for drawing; the server decides every write and its refusal is said in words. Every action sends `expectedStatus` (the status the
// card showed): a boost that moved meanwhile answers 409 and the page refreshes. A `spend_above_budget` warning is a notice, never an error: the spend is saved.
import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { Modal } from "@/components/overlay/Modal";
import { RefusalNote } from "@/components/social/PostRefusal";
import { formatDateTime } from "@/lib/format";
import { runBoostAction, type BoostAnswer } from "@/lib/socialBoostsActions";
import {
  APPROVED_VIA_LABEL, BOOST_AUDIENCE_LABEL, BOOST_GOAL_LABEL, boostOffers, boostStatusLabel, boostWarningText, buildBoostAction, daysText, emptyActionForm, formatBoostCount,
  formatBoostMoney, hasHiddenOffers, plainDate, type ActionForm, type BoostActionName, type BoostAudience, type BoostGoal, type BoostRow,
} from "@/lib/socialBoosts";
import { CHANNEL_LABEL, CHANNELS, NOTE_MAX, type Refusal } from "@/lib/socialPipeline";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/boosts.css";

const WITH_DIALOG: ReadonlySet<BoostActionName> = new Set(["stop_boost", "complete_boost", "record_boost_approval", "record_boost_decline"]);

export function BoostChip({ status, simulated }: { status: string; simulated?: boolean }) {
  return (
    <>
      <span className="scp-boostchip" data-status={status}>{boostStatusLabel(status)}</span>
      {simulated && <span className="scp-chip scp-chip--sim">SIMULATED</span>}
    </>
  );
}

export function BoostCard({ boost: initial, canRun, canRecord, postHref, onChanged }: {
  boost: BoostRow;
  /** A mirror of "the officer, the HoD or the GM": the run actions are drawn for them. The server decides. */
  canRun: boolean;
  /** A mirror of "one of the four approvers" (the budget read's `canRecord`): the two record actions are drawn for them. The server decides. */
  canRecord: boolean;
  /** When set, the title links to the post (the Boosting list); the post page itself leaves it out. */
  postHref?: string;
  /** Called after the server took an action (the page refreshes what else it shows). */
  onChanged?: () => void;
}) {
  const uid = useId();
  const [boost, setBoost] = useState(initial);
  const [seen, setSeen] = useState(initial);
  // A fresh read replaces what an action showed: the server's copy is the truth.
  if (initial !== seen) { setSeen(initial); setBoost(initial); }
  const [dialog, setDialog] = useState<BoostActionName | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string; lines: string[] } | null>(null);
  const [error, setError] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();

  const offers = boostOffers(boost.status, { canRun, canRecord });
  const hidden = hasHiddenOffers(boost.status, { canRun, canRecord });
  const money = (n: number | null) => formatBoostMoney(n, boost.currency, boost.minorUnit);

  function send(body: Record<string, unknown>, label: string) {
    setError(null);
    start(async () => {
      const r = await runBoostAction(boost.id, body);
      if (!r.ok) {
        setError({ refusal: r.refusal, message: r.message });
        if (r.refusal.error === "boost_status_changed" || r.refusal.error === "invalid_boost_transition") onChanged?.();
        return;
      }
      const a: BoostAnswer = r;
      if (a.boost) setBoost(a.boost);
      setDialog(null);
      setNotice({
        kind: a.warnings.length > 0 ? "warn" : "ok",
        text: a.alreadyApplied ? "That step was already done." : `${label}.`,
        lines: a.warnings.map(boostWarningText),
      });
      onChanged?.();
    });
  }

  function press(action: BoostActionName, label: string) {
    setNotice(null);
    setError(null);
    if (WITH_DIALOG.has(action)) { setDialog(action); return; }
    const built = buildBoostAction(action, boost.status, emptyActionForm(), boost.minorUnit);
    if (built.ok) send(built.body, label);
  }

  const results = boost.status === "stopped" || boost.status === "completed";
  const headId = `${uid}-h`;
  return (
    <section className="scp-boostcard" data-status={boost.status} aria-labelledby={headId}>
      <div className="scp-boostcard__head">
        <h4 id={headId} className="scp-row__label" style={{ margin: 0 }}>
          {postHref ? <Link href={postHref} className="scp-boostrow__title">{boost.postTitle || "This post"}</Link> : "This post's boost"}
        </h4>
        <BoostChip status={boost.status} simulated={boost.simulated} />
      </div>

      <dl className="scp-boostcard__facts" aria-label="The boost">
        <div><dt>Goal</dt><dd>{BOOST_GOAL_LABEL[boost.goal as BoostGoal] ?? boost.goal}</dd></div>
        <div><dt>Audience</dt><dd>{BOOST_AUDIENCE_LABEL[boost.audience as BoostAudience] ?? boost.audience}{boost.audienceNote ? `: ${boost.audienceNote}` : ""}</dd></div>
        <div><dt>Budget</dt><dd>{money(boost.totalBudgetMinor)} ({money(boost.dailyBudgetMinor)} a day, {daysText(boost.days)})</dd></div>
        <div><dt>Starts on</dt><dd>{plainDate(boost.startsOn)}</dd></div>
        {boost.approvedVia && <div><dt>Approved</dt><dd>{APPROVED_VIA_LABEL[boost.approvedVia]}{boost.approvedAt ? `, ${formatDateTime(boost.approvedAt)}` : ""}</dd></div>}
        {boost.startedAt && <div><dt>Started</dt><dd>{formatDateTime(boost.startedAt)}</dd></div>}
        {boost.endedAt && <div><dt>Ended</dt><dd>{formatDateTime(boost.endedAt)}</dd></div>}
        {boost.reachEstimate && !results && <div><dt>Estimated reach</dt><dd>{formatBoostCount(boost.reachEstimate.low)} to {formatBoostCount(boost.reachEstimate.high)}</dd></div>}
        {results && (
          <>
            <div><dt>Spend</dt><dd>{money(boost.spendMinor)}</dd></div>
            <div><dt>Paid reach</dt><dd className={boost.paidReach === null ? "scp-row__value--empty" : undefined}>{formatBoostCount(boost.paidReach)}</dd></div>
            <div><dt>Clicks</dt><dd className={boost.clicks === null ? "scp-row__value--empty" : undefined}>{formatBoostCount(boost.clicks)}</dd></div>
          </>
        )}
      </dl>

      {boost.status === "requested" && (
        <p className="scp-field__hint" style={{ margin: 0 }}>This boost is over what remains of the month&apos;s agreed budget, so it waits for the client to approve it in the portal, or for one of the four approvers to record their answer.</p>
      )}
      {boost.status === "cancelled" && <p className="scp-field__hint" style={{ margin: 0 }}>Cancelled: it no longer counts against the month&apos;s budget.</p>}
      {boost.status === "declined" && <p className="scp-field__hint" style={{ margin: 0 }}>The client declined this boost: it does not count against the month&apos;s budget.</p>}

      {notice && (
        <div className={`scp-post__banner scp-post__banner--${notice.kind === "warn" ? "changes" : "ok"}`} role="status">
          {notice.text}
          {notice.lines.length > 0 && <ul>{notice.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}
      {error && !dialog && <RefusalNote refusal={error.refusal} message={error.message} />}

      {offers.length > 0 && (
        <div className="scp-boostcard__actions" role="group" aria-label="Boost actions">
          {offers.map((o) => (
            <button key={o.action} type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => press(o.action, o.label)}>{o.label}</button>
          ))}
        </div>
      )}
      {hidden && (
        <p className="scp-field__hint" style={{ margin: 0 }}>
          {canRun && !canRecord
            ? "Only one of the four approvers (the Social Media head, the GM, the owner or the superadmin) can record the client's answer."
            : "Only the client's officer, the Social Media head or the GM can run a boost."}
        </p>
      )}

      {dialog && (
        <BoostActionDialog
          action={dialog} boost={boost} pending={pending} error={error} onClose={() => { setDialog(null); setError(null); }}
          onSubmit={(body) => send(body, offers.find((o) => o.action === dialog)?.label ?? dialog)}
        />
      )}
    </section>
  );
}

function BoostActionDialog({ action, boost, pending, error, onClose, onSubmit }: {
  action: BoostActionName; boost: BoostRow; pending: boolean; error: { refusal: Refusal; message: string } | null; onClose: () => void; onSubmit: (body: Record<string, unknown>) => void;
}) {
  const uid = useId();
  const [f, setF] = useState<ActionForm>(emptyActionForm());
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const set = (patch: Partial<ActionForm>) => { setLocal(null); setF((x) => ({ ...x, ...patch })); };
  // A 400 that names a field goes beside that input.
  useEffect(() => { if (error && error.refusal.status === 400 && error.refusal.field) setLocal({ field: error.refusal.field, message: error.message }); }, [error]);
  const label = { stop_boost: "Stop the boost", complete_boost: "Complete the boost", record_boost_approval: "Record the client's approval", record_boost_decline: "Record the client's decline" }[action as string] ?? action;
  const money = action === "stop_boost" || action === "complete_boost";
  const record = action === "record_boost_approval" || action === "record_boost_decline";

  function submit() {
    const built = buildBoostAction(action, boost.status, f, boost.minorUnit);
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); return; }
    onSubmit(built.body);
  }
  const err = (field: string) => (local?.field === field ? local.message : null);
  const a11y = (field: string, id: string) => (err(field) ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});
  const showRefusal = error && !(error.refusal.status === 400 && error.refusal.field);

  return (
    <Modal
      open onClose={onClose} title={label} size="md"
      footer={
        <>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending}>{pending ? "Working…" : label}</button>
        </>
      }
    >
      <div className="scp-dialog">
        {money && (
          <>
            <p className="scp-field__hint" style={{ margin: 0 }}>
              Type in the figures the network shows for this boost. The spend is what counts against the month&apos;s budget from now on.
              {action === "stop_boost" ? " Paid reach and clicks are optional now, and can be given when you complete it." : " Clicks are optional."}
            </p>
            <div className="scp-boostgrid">
              <div className="scp-field">
                <label htmlFor={`${uid}-spend`}>Total spend ({boost.currency}, required)</label>
                <input id={`${uid}-spend`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={f.spend} onChange={(e) => set({ spend: e.target.value })} {...a11y("spendMinor", `${uid}-spend`)} />
                {err("spendMinor") && <span id={`${uid}-spend-err`} className="scp-msg scp-msg--error" role="alert">{err("spendMinor")}</span>}
              </div>
              <div className="scp-field">
                <label htmlFor={`${uid}-reach`}>{action === "complete_boost" ? "Paid reach (required)" : "Paid reach (optional)"}</label>
                <input id={`${uid}-reach`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={f.paidReach} onChange={(e) => set({ paidReach: e.target.value })} {...a11y("paidReach", `${uid}-reach`)} />
                {err("paidReach") && <span id={`${uid}-reach-err`} className="scp-msg scp-msg--error" role="alert">{err("paidReach")}</span>}
              </div>
              <div className="scp-field">
                <label htmlFor={`${uid}-clicks`}>Clicks (optional)</label>
                <input id={`${uid}-clicks`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={f.clicks} onChange={(e) => set({ clicks: e.target.value })} {...a11y("clicks", `${uid}-clicks`)} />
                {err("clicks") && <span id={`${uid}-clicks-err`} className="scp-msg scp-msg--error" role="alert">{err("clicks")}</span>}
              </div>
            </div>
          </>
        )}
        {record && (
          <>
            <p className="scp-field__hint" style={{ margin: 0 }}>
              {action === "record_boost_approval" ? "The client agreed to this boost outside the portal. Recording it approves the boost." : "The client declined this boost outside the portal. Recording it declines the boost."}
            </p>
            <div className="scp-field">
              <label htmlFor={`${uid}-channel`}>How did the client tell you?</label>
              <select id={`${uid}-channel`} className="scp-input" value={f.channel} onChange={(e) => set({ channel: e.target.value })} {...a11y("channel", `${uid}-channel`)}>
                <option value="">Choose…</option>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
              {err("channel") && <span id={`${uid}-channel-err`} className="scp-msg scp-msg--error" role="alert">{err("channel")}</span>}
            </div>
            <div className="scp-field">
              <label htmlFor={`${uid}-note`}>Note (required)</label>
              <textarea id={`${uid}-note`} className="scp-input" value={f.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} {...a11y("note", `${uid}-note`)} />
              <span className="scp-field__hint">What the client said, and when. Up to {NOTE_MAX} characters.</span>
              {err("note") && <span id={`${uid}-note-err`} className="scp-msg scp-msg--error" role="alert">{err("note")}</span>}
            </div>
          </>
        )}
        {showRefusal && <RefusalNote refusal={error.refusal} message={error.message} />}
      </div>
    </Modal>
  );
}
