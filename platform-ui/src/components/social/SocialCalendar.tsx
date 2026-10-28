"use client";
// SCP-3e (plan §6.2, §8 row 3e; BFF §63.10, §59) — the Social Media calendar: every client's pipeline posts on a Monday-first month, each a chip edged in its phase's
// token, with the department's holidays and approved leave beside them and the Composer's own posts kept (read-only links to the Composer).
//
// THE GRID IS A REAL TABLE (a caption, `scope="col"` weekday headers, a cell per day with its date), and every post is a link to its page. A chip says its client,
// its title, its time, and, for a screen reader, its phase and status and whether its date is locked: colour is never the only signal.
//
// MOVING A DATE follows the server's answer, `dateMove` on each item of `GET calendar` (the fixture's rule; `moveRuleOf` only words it): drag a chip to another day, or press its "Move to date…" button (drag alone is not accessible):
//   an edit (planned, drafting, a team copy change)   moves at once: `PATCH posts/:postId/pipeline` with the new `scheduledAt`, the time of day kept
//   approved, scheduled                               asks first: the client will be asked to approve the new date again; then `reschedule` with `at`
//   anything else                                      cannot be dragged (no `draggable`); its button opens the reason
// A refusal is shown in words (`refusalText`, the blockers under it), a success is said in a status line, and the page is refreshed after each move.
//
// PLANNING: a day of the month on show has a "+" that opens `CalendarPlan`, offered only when the viewer may create a post for at least one client (its officer, or one of
// the four approvers: `PlanClient.canCreate`). That is a courtesy, not security: the server decides a create, and its refusal is shown in words.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { CalendarPlan, type Planned } from "@/components/social/CalendarPlan";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import { dayLabel } from "@/lib/deptCalendar";
import { runPostAction, savePostFields, type WriteResult } from "@/lib/socialPipelineActions";
import { newActionId } from "@/lib/socialPipeline";
import { formatWords, monthGrid, monthTitle, phaseLabel, phaseStyle, postHref, statusLabel } from "@/lib/socialClient";
import {
  CALENDAR_WEEKDAYS, movedWords, moveRuleOf, rescheduleWarning, shiftToDay,
  type ComposerEntry, type DayItem, type DayNote, type MoveRule, type PlanClient,
} from "@/lib/socialCalendar";

type Failed = Extract<WriteResult, { ok: false }>;
interface MoveState { item: DayItem; rule: MoveRule; /** The date the dialog opens on: the day it was dropped on, or the one the post is on. */ day: string }
interface Notice { text: string; href?: string; hrefLabel?: string }

export function SocialCalendar({
  deptId, month, today, items, composer, notes, clients, summary,
}: {
  deptId: string;
  /** The month on show, `YYYY-MM`. */
  month: string;
  /** Today in the company's display zone, `YYYY-MM-DD`. */
  today: string;
  items: readonly DayItem[];
  composer: readonly ComposerEntry[];
  /** Holidays and away colleagues by day (the department calendar's HR legs). */
  notes: Readonly<Record<string, readonly DayNote[]>>;
  /** The clients a day's "+" can plan for; null when they could not be read (no "+", and the page says so). */
  clients: readonly PlanClient[] | null;
  /** The caption: how many posts are in view. */
  summary: string;
}) {
  const router = useRouter();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [pending, start] = useTransition();

  const weeks = monthGrid(month);
  /** The "+" is offered only to someone who may create a post for at least one client. */
  const canPlan = clients !== null && clients.some((c) => c.canCreate);
  const byDay = new Map<string, DayItem[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  const composerByDay = new Map<string, ComposerEntry[]>();
  for (const c of composer) composerByDay.set(c.day, [...(composerByDay.get(c.day) ?? []), c]);

  /** Runs the move the rule names (an edit or `reschedule`); `then` runs once the server has taken it. */
  function commit(item: DayItem, rule: MoveRule, nextIso: string, then: () => void) {
    setFailure(null);
    setNotice(null);
    start(async () => {
      const r = rule.kind === "reschedule"
        ? await runPostAction(item.postId, { action: "reschedule", expectedStatus: item.pipelineStatus, actionId: newActionId(), at: nextIso })
        : await savePostFields(item.postId, item.pipelineStatus, { scheduledAt: nextIso });
      if (!r.ok) {
        setFailure(r);
        // Someone moved the post on: the page on show is stale, so show what it is now.
        if (r.refusal.error === "status_changed") router.refresh();
        return;
      }
      setNotice({ text: movedWords(item, rule, nextIso) });
      then();
      router.refresh();
    });
  }

  function drop(day: string) {
    setOverDay(null);
    const id = dragId;
    setDragId(null);
    const item = items.find((i) => i.postId === id);
    if (!item || item.day === day) return;
    const rule = moveRuleOf(item);
    if (rule.kind === "locked") { setFailure(null); setNotice({ text: `"${item.title}" cannot be moved. ${rule.why}` }); return; }
    if (rule.kind === "reschedule") { setFailure(null); setNotice(null); setMove({ item, rule, day }); return; }
    const nextIso = shiftToDay(item.scheduledAt, day);
    if (!nextIso) { setFailure(null); setNotice({ text: `"${item.title}" cannot go on ${dayLabel(day)}: its time does not exist on that day.` }); return; }
    commit(item, rule, nextIso, () => undefined);
  }

  function planned(p: Planned) {
    setPlan(null);
    setFailure(null);
    setNotice({ text: `Planned "${p.title}" for ${p.clientName} on ${dayLabel(p.day)}.`, href: postHref(deptId, p.postId), hrefLabel: "Open it" });
    router.refresh();
  }

  return (
    <div className="scp-calpage">
      <div className="scp-cal__status" role="status" aria-live="polite">
        {notice && (
          <p className="scp-msg scp-msg--ok">
            {notice.text}{notice.href && <> <Link href={notice.href}>{notice.hrefLabel}</Link></>}
          </p>
        )}
      </div>
      {failure && !move && <RefusalNote refusal={failure.refusal} message={failure.message} />}

      <div className="scp-tablewrap">
        <table className="scp-cal scp-cal--social">
          <caption>{monthTitle(month)}, weeks start on Monday. {summary}</caption>
          <thead>
            <tr>{CALENDAR_WEEKDAYS.map((d) => <th key={d} scope="col">{d}</th>)}</tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0].iso}>
                {w.map((d) => {
                  const posts = byDay.get(d.iso) ?? [];
                  const entries = composerByDay.get(d.iso) ?? [];
                  const day = notes[d.iso] ?? [];
                  const cls = ["scp-cal__cell", d.inMonth ? "" : "scp-cal__out", d.iso === today ? "scp-cal__today" : "", overDay === d.iso ? "scp-cal__over" : ""].filter(Boolean).join(" ");
                  return (
                    <td
                      key={d.iso} className={cls} data-day={d.iso}
                      onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverDay(d.iso); } }}
                      onDragLeave={() => setOverDay((o) => (o === d.iso ? null : o))}
                      onDrop={(e) => { e.preventDefault(); drop(d.iso); }}
                    >
                      <div className="scp-cal__head">
                        <time className="scp-cal__day" dateTime={d.iso} title={dayLabel(d.iso)}>
                          {Number(d.iso.slice(8))}
                          {d.iso === today && <span className="scp-sr-only"> (today)</span>}
                        </time>
                        {d.iso === today && <span className="scp-cal__todaymark" aria-hidden="true">Today</span>}
                        {canPlan && d.inMonth && (
                          <button type="button" className="scp-cal__add" aria-label={`Plan a post on ${dayLabel(d.iso)}`} title="Plan a post" onClick={() => { setNotice(null); setFailure(null); setPlan(d.iso); }}>
                            +
                          </button>
                        )}
                      </div>
                      {(day.length > 0 || posts.length > 0 || entries.length > 0) && (
                        <ul className="scp-cal__items">
                          {day.map((n) => (
                            <li key={n.key}>
                              <span className={`scp-cal__note scp-cal__note--${n.kind}`} title={n.detail ? `${n.label}, ${n.detail}` : n.label}>
                                <span className="scp-cal__notekind">{n.kind === "holiday" ? "Holiday: " : "Away: "}</span>{n.label}
                              </span>
                            </li>
                          ))}
                          {posts.map((it) => {
                            const rule = moveRuleOf(it);
                            const movable = rule.kind !== "locked";
                            return (
                              <li key={it.postId} className="scp-cal__row">
                                <Link
                                  href={postHref(deptId, it.postId)} className={`scp-cal__post${movable ? " scp-cal__post--movable" : ""}`} style={phaseStyle(it.phase)} data-phase={it.phase ?? ""}
                                  draggable={movable && !pending}
                                  onDragStart={(e) => { e.dataTransfer?.setData("text/plain", it.postId); setDragId(it.postId); }}
                                  onDragEnd={() => { setDragId(null); setOverDay(null); }}
                                  title={`${it.clientName} · ${it.title} · ${formatWords(it.format)} · ${statusLabel(it.pipelineStatus)} · ${phaseLabel(it.phase)}${rule.kind === "locked" ? ` · Date locked: ${rule.why}` : ""}`}
                                >
                                  <span className="scp-cal__time">{it.time}</span> <span className="scp-cal__who">{it.clientName}</span> {it.title}
                                  {it.simulated && <> <SimulatedMark /></>}
                                  <span className="scp-sr-only">. {phaseLabel(it.phase)}, {statusLabel(it.pipelineStatus)}{rule.kind === "locked" ? ", date locked" : ""}</span>
                                </Link>
                                <button
                                  type="button" className="scp-cal__move" disabled={pending} aria-label={`Move to date: ${it.clientName}, ${it.title}`} title={rule.kind === "locked" ? "Why the date is locked" : "Move to date…"}
                                  onClick={() => { setFailure(null); setNotice(null); setMove({ item: it, rule, day: it.day }); }}
                                >
                                  <span aria-hidden="true">{rule.kind === "locked" ? "⊘" : "⇄"}</span>
                                </button>
                              </li>
                            );
                          })}
                          {entries.map((c) => (
                            <li key={c.postId}>
                              <Link href={`/departments/${encodeURIComponent(deptId)}/composer/${encodeURIComponent(c.postId)}`} className="scp-cal__post scp-cal__post--composer" title={`Composer post · ${c.title}${c.status ? ` · ${c.status}` : ""}`}>
                                <span className="scp-cal__time">{c.time}</span> {c.title}
                                <span className="scp-sr-only">. Composer post{c.status ? `, ${c.status}` : ""}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {move && (
        <MoveDialog
          key={move.item.postId} state={move} pending={pending} failure={failure}
          onClose={() => { setMove(null); setFailure(null); }}
          onSubmit={(day) => {
            const nextIso = shiftToDay(move.item.scheduledAt, day);
            if (!nextIso) return false;
            commit(move.item, move.rule, nextIso, () => setMove(null));
            return true;
          }}
        />
      )}
      {plan && clients && <CalendarPlan deptId={deptId} day={plan} month={month} clients={clients} onClose={() => setPlan(null)} onDone={planned} />}
    </div>
  );
}

// ── The move dialog: the keyboard path, and the confirm for a post the client approved ───────────────────────────────────────────

function MoveDialog({
  state, pending, failure, onClose, onSubmit,
}: {
  state: MoveState; pending: boolean; failure: Failed | null; onClose: () => void; onSubmit: (day: string) => boolean;
}) {
  const uid = useId();
  const { item, rule } = state;
  const [day, setDay] = useState(state.day);
  const [local, setLocal] = useState<string | null>(null);
  const nextIso = shiftToDay(item.scheduledAt, day);
  const label = rule.kind === "reschedule" ? "Move and ask the client again" : "Move";

  function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { setLocal("Choose a date."); return; }
    if (day === item.day) { setLocal("Choose a different day from the one it is on."); return; }
    if (!onSubmit(day)) setLocal(`Its time of day does not exist on ${dayLabel(day)}. Choose another day.`);
  }

  return (
    <Modal
      open onClose={onClose} title={rule.kind === "locked" ? "The date is locked" : "Move to date"} size="md"
      footer={
        rule.kind === "locked" ? (
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onClose}>Done</button>
        ) : (
          <>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending}>{pending ? "Moving…" : label}</button>
          </>
        )
      }
    >
      <div className="scp-dialog">
        <p className="scp-note" style={{ margin: 0 }}>
          <strong>{item.title}</strong> for {item.clientName}: {statusLabel(item.pipelineStatus)}, now on {dayLabel(item.day)} at {item.time}.
        </p>
        {rule.kind === "locked" ? (
          <p className="scp-note scp-note--reason" style={{ margin: 0 }}>{rule.why}</p>
        ) : (
          <>
            <div className="scp-field">
              <label htmlFor={`${uid}-day`}>New date</label>
              <input
                id={`${uid}-day`} type="date" className="scp-input" value={day} onChange={(e) => { setLocal(null); setDay(e.target.value); }}
                aria-invalid={local !== null} aria-describedby={`${uid}-hint`}
              />
              <span id={`${uid}-hint`} className="scp-field__hint">The time of day stays {item.time}.</span>
            </div>
            {rule.kind === "reschedule" && nextIso && day !== item.day ? (
              rescheduleWarning(item, nextIso).map((t) => <p key={t} className="scp-note scp-note--reason" style={{ margin: 0 }}>{t}</p>)
            ) : rule.kind === "reschedule" ? (
              <p className="scp-note scp-note--reason" style={{ margin: 0 }}>The client approved this post for its present date. A new date means the client will be asked to approve it again, on every network.</p>
            ) : null}
          </>
        )}
        {local && <p className="scp-msg scp-msg--error" role="alert">{local}</p>}
        {failure && <RefusalNote refusal={failure.refusal} message={failure.message} />}
      </div>
    </Modal>
  );
}
