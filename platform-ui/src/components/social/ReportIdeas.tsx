"use client";
// SCP-5 W5-A4 (BFF §63.25.4): "Ideas for next month", on the MONTHLY report's page only. The client's ideas with their state (Proposed, Shared with client, Added to plan with "Open post"), and for the
// client's officer and the four approvers: Add idea (what we saw, the metric it rests on, what we suggest), Add to next plan (with the cycle picker), Mark shared and Delete. An idea added here carries
// the report's id.
//
// EVERY ACTION IS SHOWN ONLY WHEN THE READ SAYS THE VIEWER MAY (`canWrite`) AND THE IDEA'S STATE ALLOWS IT (`actionsFor`); a refusal the server still gives (the officer of another client holding no flag, a
// race) is said in words under the section, never as a code. Ideas are the team's notes: they stay internal, and "Mark shared" only records that the team shared one with the client.
import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { newUuid } from "@/lib/socialClient";
import type { Refusal } from "@/lib/socialPipeline";
import { IDEA_WRITE_REASON, METRIC_MAX, SAW_MAX, SUGGESTION_MAX, actionsFor, buildIdeaBody, emptyIdeaForm, ideaStatusWords, type CycleChoice, type Idea, type IdeaForm } from "@/lib/socialIdeas";
import { periodWords } from "@/lib/socialReports";
import { addIdea, deleteIdea, planIdea, shareIdea, type IdeaWrite } from "@/lib/socialIdeasActions";
import "./cycles.css";
import "./reports.css";

export function ReportIdeas({ deptId, engagementId, reportId, ideas, metricRequired, cycles }: {
  deptId: string;
  engagementId: string;
  /** The monthly report these ideas are raised with: an idea added here carries it. */
  reportId: string;
  /** The client's ideas and the server's `canWrite`, or null when they could not be read (then said, never an empty list). */
  ideas: { items: readonly Idea[]; canWrite: boolean } | { unavailable: string } ;
  metricRequired: boolean;
  /** The client's plans a person may add an idea to: the next open cycle and the ones after it. */
  cycles: readonly CycleChoice[];
}) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<IdeaForm>(emptyIdeaForm());
  const [local, setLocal] = useState<{ field: keyof IdeaForm; message: string } | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState<string>(cycles[0]?.cycleId ?? "");
  const [pending, start] = useTransition();
  const err = (f: keyof IdeaForm) => (local?.field === f ? local.message : null);

  function done(r: IdeaWrite, text: string) {
    if (r.ok) { setRefusal(null); setNotice(text); router.refresh(); return true; }
    setNotice(null);
    setRefusal({ refusal: r.refusal, message: r.message });
    // A refusal that says the idea moved: the page is read again, so what is drawn is what is true.
    if (r.refusal.status === 409 || r.refusal.status === 404) router.refresh();
    return false;
  }

  function add() {
    const built = buildIdeaBody(form, { metricRequired, reportId });
    if (!built.ok) { setLocal({ field: built.field, message: built.message }); setRefusal(null); return; }
    setLocal(null); setNotice(null);
    start(async () => { if (done(await addIdea(engagementId, built.body, newUuid()), "Idea added.")) setForm(emptyIdeaForm()); });
  }
  const act = (fn: () => Promise<IdeaWrite>, text: string) => { setRefusal(null); setNotice(null); start(async () => { done(await fn(), text); }); };
  function plan(id: string) {
    setRefusal(null); setNotice(null);
    start(async () => {
      const r = await planIdea(id, cycleId);
      if (done(r, "Added to the plan.")) setPlanFor(null);
    });
  }

  const unavailable = "unavailable" in ideas;
  const canWrite = !unavailable && ideas.canWrite;
  const items = unavailable ? [] : ideas.items;
  const field = (k: keyof IdeaForm, label: string, max: number, rows: number, hint?: string) => {
    const e = err(k);
    const v = form[k];
    return (
      <div className="scp-field">
        <label htmlFor={`${uid}-${k}`}>{label}</label>
        <textarea id={`${uid}-${k}`} className="scp-input" rows={rows} value={v} onChange={(ev) => { setLocal(null); setForm((f) => ({ ...f, [k]: ev.target.value })); }}
          aria-invalid={e ? true : undefined} aria-describedby={[hint ? `${uid}-${k}-hint` : "", e ? `${uid}-${k}-err` : ""].filter(Boolean).join(" ") || undefined} />
        {hint && <span id={`${uid}-${k}-hint`} className="scp-field__hint">{hint}</span>}
        <span className={`scp-report__count${[...v].length > max ? " scp-report__count--over" : ""}`}>{[...v].length} / {max}</span>
        {e && <span id={`${uid}-${k}-err`} className="scp-msg scp-msg--error" role="alert">{e}</span>}
      </div>
    );
  };

  return (
    <section className="scp-ideas" aria-labelledby={`${uid}-title`}>
      <h3 className="scp-post__section-title" id={`${uid}-title`}>Ideas for next month</h3>
      <p className="scp-field__hint">What we saw, the metric it rests on and what we suggest. Ideas are the team&apos;s notes and stay internal. Marking one shared only records that the team shared it with the client.</p>

      {unavailable ? (
        <p className="scp-note" role="status">The ideas could not be read just now. {ideas.unavailable}</p>
      ) : items.length === 0 ? (
        <p className="scp-note" role="status">No ideas for this client yet.{canWrite ? " Add the first one below." : ""}</p>
      ) : (
        <ul className="scp-ideas__list" aria-label="Ideas">
          {items.map((i) => {
            const a = actionsFor(i, canWrite);
            return (
              <li key={i.id} className="scp-ideas__item">
                <div className="scp-ideas__head">
                  <span className={`scp-reports__state scp-ideas__state--${i.status}`}>{ideaStatusWords(i.status)}</span>
                  {i.status === "planned" && i.post && <Link className="scp-link" href={`/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(i.post.id)}`}>Open post{i.post.cycleMonth ? ` (${periodWords(i.post.cycleMonth)})` : ""}</Link>}
                </div>
                <dl className="scp-ideas__body">
                  <dt>What we saw</dt><dd>{i.saw}</dd>
                  <dt>The metric</dt><dd>{i.metric ?? "None named"}</dd>
                  <dt>What we suggest</dt><dd>{i.suggestion}</dd>
                </dl>
                {i.sharedAt && i.sharedBy && <p className="scp-field__hint" style={{ margin: 0 }}>Shared with the client by {i.sharedBy.name || "a colleague"}.</p>}
                {(a.plan || a.share || a.remove) && (
                  <div className="scp-report__buttons">
                    {a.plan && <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} aria-expanded={planFor === i.id} onClick={() => { setPlanFor(planFor === i.id ? null : i.id); setRefusal(null); }}>Add to next plan</button>}
                    {a.share && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => act(() => shareIdea(i.id), "Marked as shared.")}>Mark shared</button>}
                    {a.remove && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} aria-label={`Delete the idea: ${i.suggestion}`} onClick={() => act(() => deleteIdea(i.id), "Idea deleted.")}>Delete</button>}
                  </div>
                )}
                {a.plan && planFor === i.id && (
                  <div className="scp-ideas__plan" role="group" aria-label="Add to next plan">
                    {cycles.length === 0 ? (
                      <p className="scp-note scp-note--reason" style={{ margin: 0 }}>This client has no plan month set up for the coming months. Set its deadlines on the Cycles page first.</p>
                    ) : (
                      <>
                        <div className="scp-field">
                          <label htmlFor={`${uid}-cycle-${i.id}`}>Plan month</label>
                          <select id={`${uid}-cycle-${i.id}`} className="scp-input" value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
                            {cycles.map((c) => <option key={c.cycleId} value={c.cycleId}>{periodWords(c.month)}</option>)}
                          </select>
                        </div>
                        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !cycleId} onClick={() => plan(i.id)}>Add to plan</button>
                        <span className="scp-field__hint">Makes a planned post of this month&apos;s plan, linked to the idea.</span>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canWrite ? (
        <form className="scp-ideas__add" aria-label="Add an idea" onSubmit={(e) => { e.preventDefault(); add(); }} noValidate>
          <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
            {field("saw", "What we saw", SAW_MAX, 2)}
            {field("metric", "The metric it rests on", METRIC_MAX, 1, metricRequired ? "Required by your company's rules." : "Optional under your company's rules.")}
            {field("suggestion", "What we suggest", SUGGESTION_MAX, 2)}
          </fieldset>
          <div><button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>Add idea</button></div>
        </form>
      ) : !unavailable && <p className="scp-note scp-note--reason">{IDEA_WRITE_REASON}</p>}

      {notice && <p className="scp-post__banner scp-post__banner--ok" role="status">{notice}</p>}
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </section>
  );
}
