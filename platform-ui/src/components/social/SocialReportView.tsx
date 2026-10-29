"use client";
// SCP-5a (BFF §63.18): one monthly report. The numbers of the month's frozen snapshot, the three areas (followers, engagement, audience) each with an insight and a suggestion, the action plan
// (at most ten rows), the narrative, and the buttons of the state.
//
//   Draft       the officer edits, asks "Draft with AI" (which only FILLS THE FORM: nothing is saved until Save) and submits it for the HoD check;
//   HoD check   still editable; the four approvers approve it (blocked, with the reason, while an area lacks its insight or its suggestion) or send it back to draft;
//   Ready       read-only; the four approvers send it (the PDF is made and published to the client's portal reports);
//   Sent        read-only, with where the client reads it.
// The buttons follow the server's `canApprove` and `canDeliver` and are DISABLED WITH THE REASON when they are not allowed (SCP-Q20: the four check and send; the officer writes and submits). The
// officer's own writes carry no flag, so those buttons are drawn and a 403 is said in words. UI gating is cosmetic: the server decides every write.
// A simulated report (a number came from the simulator) carries the SIMULATED mark beside its title and a note that the PDF is watermarked.
import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReportViewer } from "@/components/reports/ReportViewer";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import type { Refusal } from "@/lib/socialPipeline";
import {
  ACTION_MAX, ACTION_PLAN_MAX, AREA_LABEL, NOTE_AREAS, NOTE_MAX, OWNER_LABEL, REPORT_STATE_HELP, REPORTS_LIST_PATH, buildReportBody, buttonsFor, draftedViaWords, emptyAction,
  formFromDetail, formFromProposal, isReportState, missingNoteLine, missingNotes, numbersDocument, periodWords, reportStateWords, sameForm,
  type ActionOwner, type NoteArea, type ReportForm, type SocialReportDetail,
} from "@/lib/socialReports";
import { approveReport, deliverReport, proposeReportDraft, saveReport, sendBackReport, submitReport, type ReportWrite } from "@/lib/socialReportsActions";
import "./cycles.css";
import "./post-page.css";
import "./reports.css";

export function SocialReportView({ deptId, report, clientName, clientReportsHref }: {
  deptId: string;
  report: SocialReportDetail;
  clientName: string;
  /** Where the client's published reports are listed for staff (the client's Reports tab); null when the client could not be resolved. */
  clientReportsHref: string | null;
}) {
  const uid = useId();
  const router = useRouter();
  const saved = formFromDetail(report);
  const [form, setForm] = useState<ReportForm>(saved);
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // When the server's copy changes (a refresh after a save, or a change made by someone else), a form with nothing unsaved follows it.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (!sameForm(lastSaved.current, saved)) {
      if (sameForm(form, lastSaved.current)) setForm(saved);
      lastSaved.current = saved;
    }
  });

  const dirty = !sameForm(form, saved);
  const b = buttonsFor(report, { dirty });
  const missing = report.kind === "monthly" ? missingNotes(report.notes) : [];
  const stateKnown = isReportState(report.status);
  const set = (patch: Partial<ReportForm>) => { setLocal(null); setForm((f) => ({ ...f, ...patch })); };
  const setNote = (area: NoteArea, k: "insight" | "suggestion", v: string) => { setLocal(null); setForm((f) => ({ ...f, notes: { ...f.notes, [area]: { ...f.notes[area], [k]: v } } })); };
  const setAction = (i: number, patch: Partial<ReportForm["actions"][number]>) => { setLocal(null); setForm((f) => ({ ...f, actions: f.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) })); };
  const err = (f: string) => (local?.field === f ? local.message : null);

  function done(r: ReportWrite, text: string | null) {
    if (r.ok) { setRefusal(null); setNotice(text); router.refresh(); return; }
    setNotice(null);
    setRefusal({ refusal: r.refusal, message: r.message });
    // A refusal that says the report moved: the page is read again, so what is drawn is what is true.
    if (r.refusal.status === 400 && /status|not_editable|from_this_status|concurrently|notes_incomplete/.test(r.refusal.error)) router.refresh();
  }

  function save() {
    const built = buildReportBody(form);
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); setRefusal(null); return; }
    start(async () => { done(await saveReport(report.id, built.body), "Saved."); });
  }
  function aiDraft() {
    setRefusal(null); setNotice(null);
    start(async () => {
      const r = await proposeReportDraft(report.id);
      if (!r.ok) { done(r, null); return; }
      setForm(formFromProposal(r.proposal));
      setLocal(null);
      setAiNote(draftedViaWords(r.proposal.draftedVia));
    });
  }
  const act = (fn: () => Promise<ReportWrite>, text: string) => { setRefusal(null); setNotice(null); start(async () => { done(await fn(), text); }); };
  function deliver() {
    setRefusal(null); setNotice(null);
    start(async () => {
      const r = await deliverReport(report.id);
      done(r, r.ok ? `Sent${r.filename ? `: ${r.filename}` : ""}. The PDF is published to the client's portal reports.` : null);
    });
  }

  const disabled = pending;
  const readOnly = !b.editable;
  const reasonId = (k: string) => `${uid}-${k}-why`;

  return (
    <div className="scp-report">
      <div className="scp-report__head">
        <h2 className="scp-report__title">{clientName}: {periodWords(report.period, report.kind)}</h2>
        <span className={`scp-reports__state scp-reports__state--${report.status}`}>{reportStateWords(report.status)}</span>
        {report.simulated && <SimulatedMark of="metrics" />}
      </div>
      <p className="scp-note" style={{ margin: 0 }}>
        {stateKnown ? REPORT_STATE_HELP[report.status as keyof typeof REPORT_STATE_HELP] : "This report is in a state this page does not know."}{" "}
        <Link className="scp-link" href={REPORTS_LIST_PATH(deptId)}>All reports</Link>
      </p>
      {report.simulated && (
        <p className="scp-report__watermark" role="note">
          Some of this month&apos;s numbers came from the social simulator, not from a network. The page and the PDF carry the watermark, and nothing here is a real client&apos;s result.
        </p>
      )}

      {missing.length > 0 && b.editable && (
        <div className="scp-post__banner scp-post__banner--changes" role="status">
          <strong>The HoD check cannot pass yet.</strong> Each of the three areas needs an insight and a suggestion.
          <ul>{missing.map((m) => <li key={m.area}>{missingNoteLine(m)}</li>)}</ul>
        </div>
      )}

      <section aria-labelledby={`${uid}-numbers`}>
        <h3 className="scp-post__section-title" id={`${uid}-numbers`}>The month&apos;s numbers</h3>
        <p className="scp-field__hint">Frozen when the report was drafted, so an approved report&apos;s numbers do not drift. A boost&apos;s spend is the client&apos;s own ad spend, never our fees.</p>
        <div className="scp-report__numbers">
          <ReportViewer document={{ ...numbersDocument(report.document), simulated: undefined }} scopeHeading={false} />
        </div>
      </section>

      <form aria-label="The report" onSubmit={(e) => { e.preventDefault(); if (b.save) save(); }} noValidate>
        <fieldset disabled={readOnly || disabled} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 16 }}>
          <section aria-labelledby={`${uid}-areas`} className="scp-report__plan">
            <h3 className="scp-post__section-title" id={`${uid}-areas`}>Followers, engagement and audience</h3>
            <p className="scp-field__hint">One insight (what the numbers show) and one suggestion (what to do about it) for each area, up to {NOTE_MAX} characters each.</p>
            <div className="scp-report__areas">
              {NOTE_AREAS.map((a) => (
                <div className="scp-report__area" key={a} role="group" aria-label={AREA_LABEL[a]}>
                  <h4>{AREA_LABEL[a]}</h4>
                  {(["insight", "suggestion"] as const).map((k) => {
                    const id = `${uid}-${a}-${k}`;
                    const v = form.notes[a][k];
                    const e = err(`notes.${a}.${k}`);
                    return (
                      <div className="scp-field" key={k}>
                        <label htmlFor={id}>{AREA_LABEL[a]} {k}</label>
                        <textarea id={id} className="scp-input" rows={3} value={v} onChange={(ev) => setNote(a, k, ev.target.value)} aria-invalid={e ? true : undefined} aria-describedby={e ? `${id}-err` : undefined} />
                        <span className={`scp-report__count${v.length > NOTE_MAX ? " scp-report__count--over" : ""}`}>{v.length} / {NOTE_MAX}</span>
                        {e && <span id={`${id}-err`} className="scp-msg scp-msg--error" role="alert">{e}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby={`${uid}-plan`} className="scp-report__plan">
            <h3 className="scp-post__section-title" id={`${uid}-plan`}>Action plan</h3>
            <p className="scp-field__hint">At most {ACTION_PLAN_MAX} actions of up to {ACTION_MAX} characters, each owned by the agency or the client, with a due date if there is one.</p>
            {form.actions.length === 0 && <p className="scp-note" style={{ margin: 0 }}>No action yet.</p>}
            {form.actions.map((a, i) => {
              const id = `${uid}-action-${i}`;
              const eA = err(`actionPlan.${i}.action`);
              const eD = err(`actionPlan.${i}.due`);
              return (
                <div className="scp-report__action" key={i} role="group" aria-label={`Action ${i + 1}`}>
                  <div className="scp-field">
                    <label htmlFor={`${id}-text`}>Action {i + 1}</label>
                    <textarea id={`${id}-text`} className="scp-input" rows={2} value={a.action} onChange={(e) => setAction(i, { action: e.target.value })} aria-invalid={eA ? true : undefined} aria-describedby={eA ? `${id}-text-err` : undefined} />
                    <span className={`scp-report__count${a.action.length > ACTION_MAX ? " scp-report__count--over" : ""}`}>{a.action.length} / {ACTION_MAX}</span>
                    {eA && <span id={`${id}-text-err`} className="scp-msg scp-msg--error" role="alert">{eA}</span>}
                  </div>
                  <div className="scp-field">
                    <label htmlFor={`${id}-owner`}>Owner of action {i + 1}</label>
                    <select id={`${id}-owner`} className="scp-input" value={a.owner} onChange={(e) => setAction(i, { owner: e.target.value as ActionOwner })}>
                      {(Object.keys(OWNER_LABEL) as ActionOwner[]).map((o) => <option key={o} value={o}>{OWNER_LABEL[o]}</option>)}
                    </select>
                  </div>
                  <div className="scp-field">
                    <label htmlFor={`${id}-due`}>Due date of action {i + 1}</label>
                    <input id={`${id}-due`} className="scp-input" type="date" value={a.due} onChange={(e) => setAction(i, { due: e.target.value })} aria-invalid={eD ? true : undefined} aria-describedby={eD ? `${id}-due-err` : undefined} />
                    {eD && <span id={`${id}-due-err`} className="scp-msg scp-msg--error" role="alert">{eD}</span>}
                  </div>
                  <div className="scp-field"><span>&nbsp;</span>
                    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Remove action ${i + 1}`} onClick={() => set({ actions: form.actions.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                </div>
              );
            })}
            {err("actionPlan") && <span className="scp-msg scp-msg--error" role="alert">{err("actionPlan")}</span>}
            <div>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={form.actions.length >= ACTION_PLAN_MAX} aria-describedby={form.actions.length >= ACTION_PLAN_MAX ? reasonId("add") : undefined}
                onClick={() => set({ actions: [...form.actions, emptyAction()] })}>Add an action</button>
              {form.actions.length >= ACTION_PLAN_MAX && <span id={reasonId("add")} className="scp-field__hint"> The plan has the most actions it can hold ({ACTION_PLAN_MAX}).</span>}
            </div>
          </section>

          <section className="scp-report__plan">
            <h3 className="scp-post__section-title" id={`${uid}-narrative`}>Narrative</h3>
            <div className="scp-field">
              <label htmlFor={`${uid}-narrative-text`}>Narrative</label>
              <textarea id={`${uid}-narrative-text`} className="scp-input" rows={6} value={form.narrative} onChange={(e) => set({ narrative: e.target.value })} />
            </div>
          </section>
        </fieldset>

        {aiNote && <p className="scp-post__banner scp-post__banner--changes" role="status" style={{ marginTop: 8 }}>{aiNote} <strong>Nothing is saved until you press Save.</strong></p>}
        {notice && <p className="scp-post__banner scp-post__banner--ok" role="status" style={{ marginTop: 8 }}>{notice}</p>}
        {refusal && <div style={{ marginTop: 8 }}><RefusalNote refusal={refusal.refusal} message={refusal.message} /></div>}

        <div className="scp-report__buttons" style={{ marginTop: 12 }}>
          {b.save && <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={disabled || !dirty}>Save</button>}
          {b.aiDraft && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={disabled} onClick={aiDraft}>Draft with AI</button>}
          {b.submit && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={disabled || dirty} aria-describedby={dirty ? reasonId("submit") : undefined}
              onClick={() => act(() => submitReport(report.id), "Submitted for the HoD check.")}>Submit for the HoD check</button>
          )}
          {b.submit && dirty && <span id={reasonId("submit")} className="scp-field__hint">Save your changes first: the check reads what is saved.</span>}
          {b.approve.shown && (
            <>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={disabled || !b.approve.allowed} aria-describedby={b.approve.reason ? reasonId("approve") : undefined}
                onClick={() => act(() => approveReport(report.id), "Approved. The report is Ready to send.")}>Approve</button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={disabled || !b.sendBack.allowed} aria-describedby={b.sendBack.reason ? reasonId("back") : undefined}
                onClick={() => act(() => sendBackReport(report.id), "Sent back to draft.")}>Send back to draft</button>
            </>
          )}
          {b.deliver.shown && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={disabled || !b.deliver.allowed} aria-describedby={b.deliver.reason ? reasonId("deliver") : undefined} onClick={deliver}>Send to the client</button>
          )}
        </div>
        {b.approve.reason && <p id={reasonId("approve")} className="scp-note scp-note--reason">{b.approve.reason}</p>}
        {b.sendBack.reason && <p id={reasonId("back")} className="scp-note scp-note--reason">{b.sendBack.reason}</p>}
        {b.deliver.reason && <p id={reasonId("deliver")} className="scp-note scp-note--reason">{b.deliver.reason}</p>}
      </form>

      {report.status === "delivered" && (
        <p className="scp-post__banner scp-post__banner--ok" role="status">
          Sent. The PDF is published to the client&apos;s portal reports, where their contacts read it. This report can no longer be changed.
          {clientReportsHref ? <> <Link className="scp-link" href={clientReportsHref}>Open this client&apos;s reports</Link></> : null}
        </p>
      )}
    </div>
  );
}
