"use client";
// SCP-5 W5-A6 (BFF §63.24.9) — the add and edit dialog of a report schedule: the kind (fixed once the schedule exists, as the server fixes it), all clients or a picker, the kind's timing
// (a time; a weekday; a day of the month or the N-th working day), and "Next runs", worked out here (there is no preview route; `previewRuns` follows the server's own walk, with Monday to
// Friday as the working days, so the card's own next run, once saved, is the server's word). Whether a kind is drafted by AI is the company's report rule, not a field of the schedule, so the dialog
// says so and offers no switch; and there is no spend cap (SCP-Q40).
//
// THE PAGE DECIDES NOTHING. The server checks the four, the body and the clients again, and every refusal is shown in words: a 400 that names a field puts its words beside that field.
import { useId, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { RefusalNote } from "@/components/social/PostRefusal";
import { editSchedule, saveSchedule } from "@/lib/socialReportSchedulesActions";
import { newUuid } from "@/lib/socialClient";
import type { Refusal } from "@/lib/socialPipeline";
import {
  KIND_LABEL, MAX_DAY, MAX_WORKING_DAY, SCHEDULE_KINDS, WEEKDAY_NAMES, buildBody, emptyForm, formOf, periodWords, previewRuns, timingOfForm, timingWords,
  type ReportSchedule, type ScheduleForm, type ScheduleKind,
} from "@/lib/socialReportSchedules";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/reportAutomation.css";

export interface ClientOption { engagementId: string; clientName: string }

export function ReportScheduleDialog({ schedule, clients, onClose, onSaved }: {
  /** The schedule being edited, or null for a new one. */
  schedule: ReportSchedule | null;
  /** The open clients of the company for the picker, or null when they could not be read. */
  clients: ClientOption[] | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const [form, setForm] = useState<ScheduleForm>(() => (schedule ? formOf(schedule) : emptyForm()));
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();
  // One id per opened dialog: a retry of the same click is the same schedule on the server.
  const newId = useRef<string>(newUuid());
  const set = (patch: Partial<ScheduleForm>) => { setLocal(null); setRefusal(null); setForm((f) => ({ ...f, ...patch })); };

  const timing = timingOfForm(form);
  const nowMs = useMemo(() => Date.now(), []);
  const preview = useMemo(() => (timing.ok ? previewRuns(form.kind, timing.timing, nowMs) : null), [form, nowMs]); // eslint-disable-line react-hooks/exhaustive-deps
  // The picker offers the open clients, plus any chosen client the read no longer lists (so an edit never silently drops one).
  const options: ClientOption[] = useMemo(() => {
    const base = clients ?? [];
    const known = new Set(base.map((c) => c.engagementId));
    const extra = (schedule?.clients ?? []).filter((c) => !known.has(c.engagementId)).map((c) => ({ engagementId: c.engagementId, clientName: c.clientName || "A client no longer open" }));
    return [...base, ...extra];
  }, [clients, schedule]);

  function submit() {
    setRefusal(null);
    setLocal(null);
    const built = buildBody(form, schedule ? { original: schedule } : { id: newId.current });
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); return; }
    if (schedule && Object.keys(built.body).length === 0) { onClose(); return; }
    start(async () => {
      const r = schedule ? await editSchedule(schedule.id, built.body) : await saveSchedule(built.body);
      if (r.ok) { onSaved(schedule ? "Schedule changed. You are now its owner: its runs act as you." : "Schedule added. Its runs act as you."); return; }
      if (r.refusal.status === 400 && r.refusal.error === "invalid_field" && r.refusal.field && r.refusal.field !== "id") setLocal({ field: r.refusal.field, message: r.message });
      else setRefusal({ refusal: r.refusal, message: r.message });
    });
  }

  const err = (f: string) => (local?.field === f ? local.message : null);
  const a11y = (f: string, id: string) => (err(f) ? { "aria-invalid": true as const, "aria-describedby": `${id}-err` } : {});
  const fieldError = (f: string, id: string) => (err(f) ? <span id={`${id}-err`} className="scp-msg scp-msg--error" role="alert">{err(f)}</span> : null);
  const kind: ScheduleKind = form.kind;
  const toggle = (id: string) => set({ engagementIds: form.engagementIds.includes(id) ? form.engagementIds.filter((x) => x !== id) : [...form.engagementIds, id] });

  return (
    <Modal
      open onClose={onClose} title={schedule ? `Change the ${KIND_LABEL[schedule.kind].toLowerCase()} schedule` : "Add a report schedule"} size="md"
      footer={
        <>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending}>{pending ? "Working…" : schedule ? "Save changes" : "Add schedule"}</button>
        </>
      }
    >
      <form className="scp-dialog scp-auto__form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <p className="scp-field__hint" style={{ margin: 0 }}>
          A schedule drafts the reports of the period that has just ended, by itself. It only drafts: approving, sending back and sending stay with the four. Whether a kind is drafted with AI is set
          in the company&apos;s report rules; a schedule whose kind is turned off, or drafted by hand, pauses itself.
        </p>

        <div className="scp-field">
          <label htmlFor={`${uid}-kind`}>Kind of report</label>
          <select id={`${uid}-kind`} className="scp-input" value={form.kind} disabled={schedule !== null} onChange={(e) => set({ kind: e.target.value as ScheduleKind })} {...a11y("kind", `${uid}-kind`)}>
            {SCHEDULE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          {schedule && <span className="scp-field__hint">The kind cannot change. To draft a different kind, add another schedule.</span>}
          {fieldError("kind", `${uid}-kind`)}
        </div>

        <fieldset className="scp-auto__fieldset" aria-describedby={err("scope") || err("engagementIds") ? `${uid}-clients-err` : undefined}>
          <legend>Clients</legend>
          <label className="scp-auto__radio"><input type="radio" name={`${uid}-scope`} checked={form.scope === "all"} onChange={() => set({ scope: "all" })} /> All clients (every client the owner may draft for, when it runs)</label>
          <label className="scp-auto__radio"><input type="radio" name={`${uid}-scope`} checked={form.scope === "chosen"} onChange={() => set({ scope: "chosen" })} /> Only these clients</label>
          {form.scope === "chosen" && (
            options.length === 0
              ? <p className="scp-note" role="status">The clients could not be listed right now, so none can be chosen. Reload the page and try again.</p>
              : (
                <ul className="scp-auto__clients" aria-label="Clients">
                  {options.map((c) => (
                    <li key={c.engagementId}>
                      <label className="scp-auto__radio">
                        <input type="checkbox" checked={form.engagementIds.includes(c.engagementId)} onChange={() => toggle(c.engagementId)} /> {c.clientName}
                      </label>
                    </li>
                  ))}
                </ul>
              )
          )}
          {(err("scope") || err("engagementIds")) && <span id={`${uid}-clients-err`} className="scp-msg scp-msg--error" role="alert">{err("scope") ?? err("engagementIds")}</span>}
        </fieldset>

        <div className="scp-auto__grid">
          {kind === "weekly" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-weekday`}>Day of the week</label>
              <select id={`${uid}-weekday`} className="scp-input" value={form.weekday} onChange={(e) => set({ weekday: e.target.value })} {...a11y("timing.weekday", `${uid}-weekday`)}>
                {WEEKDAY_NAMES.map((d, i) => <option key={d} value={String(i + 1)}>{d}</option>)}
              </select>
              {fieldError("timing.weekday", `${uid}-weekday`)}
            </div>
          )}
          {kind !== "daily" && kind !== "weekly" && (
            <>
              <div className="scp-field">
                <label htmlFor={`${uid}-on`}>Runs on</label>
                <select id={`${uid}-on`} className="scp-input" value={form.monthlyOn} onChange={(e) => set({ monthlyOn: e.target.value as "day" | "working_day" })} {...a11y("timing.on", `${uid}-on`)}>
                  <option value="working_day">A working day of the month</option>
                  <option value="day">A day of the month</option>
                </select>
                <span className="scp-field__hint">{kind === "monthly" ? "Of each month" : `Of the month after each ${kind === "quarterly" ? "quarter" : kind === "semester" ? "half year" : "year"} ends`}</span>
                {fieldError("timing.on", `${uid}-on`)}
              </div>
              {form.monthlyOn === "day" ? (
                <div className="scp-field">
                  <label htmlFor={`${uid}-day`}>Day of the month (1 to {MAX_DAY})</label>
                  <input id={`${uid}-day`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.day} onChange={(e) => set({ day: e.target.value })} {...a11y("timing.day", `${uid}-day`)} />
                  {fieldError("timing.day", `${uid}-day`)}
                </div>
              ) : (
                <div className="scp-field">
                  <label htmlFor={`${uid}-n`}>Which working day (1 to {MAX_WORKING_DAY})</label>
                  <input id={`${uid}-n`} className="scp-input" type="text" inputMode="numeric" autoComplete="off" value={form.n} onChange={(e) => set({ n: e.target.value })} {...a11y("timing.n", `${uid}-n`)} />
                  <span className="scp-field__hint">The company&apos;s working days, holidays left out.</span>
                  {fieldError("timing.n", `${uid}-n`)}
                </div>
              )}
            </>
          )}
          <div className="scp-field">
            <label htmlFor={`${uid}-at`}>Time of day</label>
            <input id={`${uid}-at`} className="scp-input" type="time" value={form.at} onChange={(e) => set({ at: e.target.value })} {...a11y("timing.at", `${uid}-at`)} />
            <span className="scp-field__hint">In the company&apos;s time zone.</span>
            {fieldError("timing.at", `${uid}-at`)}
          </div>
        </div>
        {err("timing") && <span className="scp-msg scp-msg--error" role="alert">{err("timing")}</span>}

        {!schedule && (
          <label className="scp-auto__radio">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Switch it on now (otherwise it is added paused)
          </label>
        )}

        <div className="scp-auto__preview" aria-live="polite">
          {timing.ok && <p className="scp-auto__words">{timingWords(kind, timing.timing)}.</p>}
          {preview && preview.length > 0
            ? (
              <>
                <p className="scp-auto__label">Next runs:</p>
                <ul className="scp-auto__runs">
                  {preview.map((p) => <li key={p.period}>{p.text}, for {p.drafts}</li>)}
                </ul>
                <p className="scp-field__hint" style={{ margin: 0 }}>
                  Worked out here with Monday to Friday as working days and no holidays. The company&apos;s calendar and time zone are applied when it is saved: the card then shows the exact next run.
                </p>
              </>
            )
            : <p className="scp-field__hint" style={{ margin: 0 }}>Fill in the timing to see the next runs.</p>}
          {schedule?.lastPeriod && <p className="scp-field__hint" style={{ margin: 0 }}>Last drafted: {periodWords(schedule.kind, schedule.lastPeriod)}.</p>}
        </div>

        <p className="scp-field__hint" style={{ margin: 0 }}>
          Saving makes you the schedule&apos;s owner: every run acts as you, and is paused if you may no longer run it. AI spend is recorded for each run and is never capped.
        </p>
        {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
}
