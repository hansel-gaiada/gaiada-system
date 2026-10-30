"use client";
// SCP-5g (BFF §63.28, §63.17): one audit's scorecard. The twelve dimensions as the company's rules set them, each with 0 to 5 by halves written in words and numbers beside a bar: an AUTOMATIC value with the
// evidence it was read from, or with the reason when it cannot be scored; a TYPED score with its note; "Use automatic" to drop an override. Then the overall out of 100 and its band, the three fixes, and
// the summary with "Draft with AI", which is a PROPOSAL: it fills the text and saves nothing until Save. While a draft the scorecard is live; Finalize freezes it as a dated record, after which the page
// is read-only and shows what was frozen. A prospect's audit can be attached once to the client it became.
//
// WHO (SCP-Q34): the server's `canWrite` and `canFinalize` decide which controls are live; a refusal of a write is said in words and says who may. The page hides nothing by role.
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SimulatedMark } from "@/components/social/SimulatedMark";
import { attachAudit, deleteAudit, finalizeAudit, proposeAuditSummary, saveAudit } from "@/lib/socialAuditActions";
import {
  AUDIT_LIMITS, HALF_STEPS, PUBLIC_KEYS, PUBLIC_LABEL, buildAuditPatch, buttonsFor, draftedViaWords, evidenceWords, formFromDetail, formWithSummary,
  isOverride, noneReasonWords, overallWords, sameForm, scoreBand, scoreText, scoreWords, scoredWords, AUDIT_LIST_PATH, subjectWords, writeReason,
  type AuditDetail, type AuditDimension, type AuditForm, type SummaryProposal,
} from "@/lib/socialAudit";
import { clientHref, monthTitle } from "@/lib/socialClient";
import { formatDate } from "@/lib/format";
import type { Refusal } from "@/lib/socialPipeline";
import "./cycles.css";
import "./audit.css";

export interface AttachableClient { engagementId: string; clientName: string }
type Say = { refusal: Refusal; message: string };

function ScoreBar({ n }: { n: number }) {
  return <span className="scp-audit__bar" aria-hidden="true"><span style={{ width: `${(n / 5) * 100}%` }} /></span>;
}

/** A dimension's automatic part in one paragraph: the score with its evidence, or none with its reason. */
function AutoLine({ d }: { d: AuditDimension }) {
  if (!d.auto) return null;
  if (d.auto.score === null) return <p className="scp-audit__line">Automatic: not scored. {noneReasonWords(d.auto.reason)}</p>;
  return <p className="scp-audit__line">Automatic: {scoreWords(d.auto.score)} ({evidenceWords(d.auto.evidence)}).</p>;
}

export function AuditView({ deptId, audit, clients }: { deptId: string; audit: AuditDetail; clients: readonly AttachableClient[] }) {
  const uid = useId();
  const router = useRouter();
  const initial = formFromDetail(audit);
  const [form, setForm] = useState<AuditForm>(initial);
  const [proposal, setProposal] = useState<SummaryProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [say, setSay] = useState<Say | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"finalize" | "delete" | null>(null);
  const [attachTo, setAttachTo] = useState(clients[0]?.engagementId ?? "");
  const [pending, start] = useTransition();
  /** Which write is in flight, so only its own button says so ("Saving…" is not said while a summary is being drafted). */
  const [doing, setDoing] = useState<"save" | "ai" | "finalize" | "delete" | "attach" | null>(null);
  const busy = (k: NonNullable<typeof doing>) => pending && doing === k;

  const dirty = !sameForm(form, initial);
  const b = buttonsFor(audit, { dirty });
  const editable = b.editable;
  const final = audit.status === "final";
  const attachedClient = audit.engagementId ? clients.find((c) => c.engagementId === audit.engagementId) : undefined;

  const setScore = (key: string, patch: Partial<{ score: string; note: string }>) =>
    setForm((f) => ({ ...f, scores: { ...f.scores, [key]: { ...(f.scores[key] ?? { score: "", note: "" }), ...patch } } }));

  function fail(r: { refusal: Refusal; message: string }) { setSay({ refusal: r.refusal, message: r.message }); }
  const begin = (k: NonNullable<typeof doing>) => { setSay(null); setNotice(null); setProblem(null); setDoing(k); };

  function save() {
    begin("save");
    // A summary the person kept from a proposal says where it came from; one they typed says typed.
    const via = proposal && form.summary.trim() === proposal.summary.trim() ? proposal.draftedVia : "typed";
    const check = buildAuditPatch(audit, form, { summaryVia: via });
    if (!check.ok) { setProblem(check.message); return; }
    start(async () => {
      const r = await saveAudit(audit.id, check.body);
      if (!r.ok) { fail(r); return; }
      setNotice("Saved.");
      router.refresh();
    });
  }

  function draftWithAi() {
    begin("ai");
    start(async () => {
      const r = await proposeAuditSummary(audit.id);
      if (!r.ok) { fail(r); return; }
      setProposal(r.proposal);
      setForm((f) => formWithSummary(f, r.proposal.summary));
      setNotice(draftedViaWords(r.proposal.draftedVia));
    });
  }

  function finalize() {
    begin("finalize");
    start(async () => {
      const r = await finalizeAudit(audit.id);
      if (!r.ok) { fail(r); setConfirm(null); return; }
      setConfirm(null);
      router.refresh();
    });
  }

  function remove() {
    begin("delete");
    start(async () => {
      const r = await deleteAudit(audit.id);
      if (!r.ok) { fail(r); setConfirm(null); return; }
      router.push(AUDIT_LIST_PATH(deptId));
    });
  }

  function attach() {
    begin("attach");
    if (!attachTo) { setProblem("Pick the client this prospect became."); return; }
    start(async () => {
      const r = await attachAudit(audit.id, attachTo);
      if (!r.ok) { fail(r); return; }
      setNotice(r.alreadyApplied ? "It was already attached to that client." : "Attached.");
      router.refresh();
    });
  }

  return (
    <div className="scp-audit">
      <header className="scp-audit__head">
        <h2 className="scp-audit__title">{audit.name || "Audit"}</h2>
        <span className="scp-saved__badge">{subjectWords(audit.subject)}</span>
        <span className="scp-saved__badge">{final ? "Final" : "Draft"}</span>
        {audit.month && <span className="scp-chead__meta">Data from {monthTitle(audit.month)}</span>}
        {audit.simulated && <><SimulatedMark of="metrics" /><span className="scp-chead__meta">An automatic score read simulated posts.</span></>}
        <Link className="scp-link" href={AUDIT_LIST_PATH(deptId)}>All audits</Link>
      </header>

      {final && (
        <p className="scp-audit__frozen" role="status">
          Final{audit.finalizedAt ? `, frozen on ${formatDate(audit.finalizedAt)}` : ""}{audit.finalizedBy ? ` by ${audit.finalizedBy.name}` : ""}. This is a dated record: the scores below are what was frozen, and nobody can change or delete them.
          For a new look, start a new audit.
        </p>
      )}
      {!final && !audit.canWrite && <p className="scp-note scp-note--reason" role="status">You can read this audit but not change it. {writeReason(audit.subject)}</p>}

      <section aria-label="Overall" className="scp-audit__overall">
        <span className="scp-audit__big">{audit.overall === null ? "No score yet" : `${audit.overall} out of 100`}</span>
        {audit.bandLabel && <span className={`scp-audit__band scp-audit__band--${audit.band ?? "none"}`}>{audit.bandLabel}</span>}
        <span className="scp-chead__meta">{scoredWords(audit.scored, audit.total)}. {overallWords(audit.overall, audit.bandLabel)}.</span>
      </section>

      {audit.subject === "prospect" && (
        <section aria-label="The prospect" className="scp-audit__panel">
          {editable ? (
            <>
              <div className="scp-audit__inputs">
                <div className="scp-field">
                  <label htmlFor={`${uid}-pname`}>Prospect&apos;s name</label>
                  <input id={`${uid}-pname`} className="scp-input" value={form.prospectName} maxLength={AUDIT_LIMITS.prospectName} onChange={(e) => setForm((f) => ({ ...f, prospectName: e.target.value }))} />
                </div>
                <div className="scp-field">
                  <label htmlFor={`${uid}-ptype`}>Business type</label>
                  <input id={`${uid}-ptype`} className="scp-input" value={form.businessType} maxLength={AUDIT_LIMITS.businessType} onChange={(e) => setForm((f) => ({ ...f, businessType: e.target.value }))} />
                </div>
              </div>
              <div className="scp-audit__inputs" role="group" aria-label="Public numbers">
                {PUBLIC_KEYS.map((k) => (
                  <div key={k} className="scp-field">
                    <label htmlFor={`${uid}-${k}`}>{PUBLIC_LABEL[k]}</label>
                    <input
                      id={`${uid}-${k}`} className="scp-input" inputMode={k === "lastPostOn" ? undefined : "decimal"} placeholder={k === "lastPostOn" ? "YYYY-MM-DD" : ""}
                      value={form.publicNumbers[k]} onChange={(e) => setForm((f) => ({ ...f, publicNumbers: { ...f.publicNumbers, [k]: e.target.value } }))}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <dl className="scp-audit__facts">
              <div className="scp-audit__fact"><dt>Business type</dt><dd>{audit.businessType ?? "Not said"}</dd></div>
              {PUBLIC_KEYS.map((k) => (audit.publicNumbers[k] !== undefined ? <div key={k} className="scp-audit__fact"><dt>{PUBLIC_LABEL[k]}</dt><dd>{String(audit.publicNumbers[k])}</dd></div> : null))}
            </dl>
          )}
          {b.attach.shown ? (
            <div className="scp-audit__inputs">
              <div className="scp-field">
                <label htmlFor={`${uid}-attach`}>Attach to the client it became</label>
                <select id={`${uid}-attach`} className="scp-input" value={attachTo} disabled={!b.attach.allowed || pending} onChange={(e) => setAttachTo(e.target.value)}>
                  {clients.length === 0 && <option value="">No client to pick</option>}
                  {clients.map((c) => <option key={c.engagementId} value={c.engagementId}>{c.clientName}</option>)}
                </select>
              </div>
              <button type="button" className="lux-btn lux-btn--sm" disabled={!b.attach.allowed || pending || !attachTo} onClick={attach}>{busy("attach") ? "Attaching…" : "Attach to client"}</button>
              {b.attach.reason && <span className="scp-field__hint">{b.attach.reason}</span>}
            </div>
          ) : audit.engagementId ? (
            <p className="scp-audit__line">
              Attached to <Link className="scp-link" href={clientHref(deptId, audit.engagementId, "plan")}>{attachedClient?.clientName ?? "the client it became"}</Link>: this audit is that client&apos;s baseline.
            </p>
          ) : null}
        </section>
      )}

      {audit.subject === "client" && editable && (
        <div className="scp-field" style={{ maxWidth: 220 }}>
          <label htmlFor={`${uid}-month`}>Data month</label>
          <input id={`${uid}-month`} type="month" className="scp-input" value={form.month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))} />
          <span className="scp-field__hint">The automatic scores read this month&apos;s pipeline. Save to recompute them.</span>
        </div>
      )}

      <section aria-label="The twelve dimensions">
        <h3 className="scp-section__title">{audit.total === 12 ? "The twelve dimensions" : `The ${audit.total} dimensions`}</h3>
        <ol className="scp-audit__dims">
          {audit.dimensions.map((d) => {
            const cur = form.scores[d.key] ?? { score: "", note: "" };
            const override = isOverride(audit.subject, d);
            const hasTyped = d.typed !== null && (d.typed.score !== null || d.typed.note !== "");
            return (
              <li key={d.key} className="scp-audit__dim" aria-label={d.label}>
                <div className="scp-audit__dim-head">
                  <h4 className="scp-audit__dim-name">{d.label}</h4>
                  <span><b>{d.used === null ? "Not scored" : scoreWords(d.used)}</b>{d.used !== null ? ` · ${scoreBand(d.used)}` : ""}</span>
                </div>
                {d.used !== null && <ScoreBar n={d.used} />}
                <AutoLine d={d} />
                {override && d.typed?.score !== null && d.typed !== null && <p className="scp-audit__line">You replaced the automatic score with {scoreWords(d.typed.score)}.</p>}
                {editable ? (
                  <div className="scp-audit__inputs">
                    <div className="scp-field">
                      <label htmlFor={`${uid}-s-${d.key}`}>{override ? "Your score (replaces the automatic one)" : "Your score"}</label>
                      <select id={`${uid}-s-${d.key}`} className="scp-input" value={cur.score} onChange={(e) => setScore(d.key, { score: e.target.value })}>
                        <option value="">{override ? "Use automatic" : "Not scored"}</option>
                        {HALF_STEPS.map((n) => <option key={n} value={scoreText(n)}>{scoreWords(n)}</option>)}
                      </select>
                    </div>
                    <div className="scp-field scp-audit__note">
                      <label htmlFor={`${uid}-n-${d.key}`}>{override ? "Why (needed when you replace the automatic score)" : "Note (optional)"}</label>
                      <textarea id={`${uid}-n-${d.key}`} className="scp-input" value={cur.note} maxLength={AUDIT_LIMITS.note} onChange={(e) => setScore(d.key, { note: e.target.value })} />
                    </div>
                    {override && (cur.score !== "" || cur.note !== "") && (
                      <button type="button" className="lux-btn lux-btn--sm" onClick={() => setScore(d.key, { score: "", note: "" })} aria-label={`Use the automatic score for ${d.label}`}>Use automatic</button>
                    )}
                  </div>
                ) : hasTyped ? (
                  <p className="scp-audit__line">{d.typed?.score !== null && d.typed ? `Typed: ${scoreWords(d.typed.score)}.` : "Typed: no score."}{d.typed?.note ? ` Note: ${d.typed.note}` : ""}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-label="The fixes">
        <h3 className="scp-section__title">Start with</h3>
        {audit.fixes.length === 0 ? <p className="scp-note">Nothing is scored yet, so there is nothing to fix first.</p> : (
          <ol className="scp-audit__fixes">
            {audit.fixes.map((f) => <li key={f.key}><b>{f.label}</b> ({scoreWords(f.score)}): {f.advice}</li>)}
          </ol>
        )}
      </section>

      <section aria-label="Summary" className="scp-audit__summary">
        <h3 className="scp-section__title">Summary</h3>
        {editable ? (
          <div className="scp-field">
            <label htmlFor={`${uid}-summary`}>Summary</label>
            <textarea id={`${uid}-summary`} className="scp-input" value={form.summary} maxLength={AUDIT_LIMITS.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} />
            <span className="scp-field__hint">Up to {AUDIT_LIMITS.summary} characters. &quot;Draft with AI&quot; writes a proposal here and saves nothing until you save.</span>
          </div>
        ) : (
          <p className="scp-saved__body">{audit.summary ?? "No summary was written."}</p>
        )}
        {audit.summary && audit.summaryVia && !editable && <p className="scp-field__hint">{audit.summaryVia === "ai" ? "Drafted with AI." : audit.summaryVia === "template" ? "From the plain template." : "Typed by the team."}</p>}
        {editable && (
          <div className="scp-audit__buttons">
            <button type="button" className="lux-btn lux-btn--sm" disabled={!b.aiSummary || pending} onClick={draftWithAi}>{busy("ai") ? "Drafting…" : "Draft with AI"}</button>
          </div>
        )}
      </section>

      {problem && <p className="scp-msg scp-msg--error" role="alert">{problem}</p>}
      {notice && <p className="scp-msg scp-msg--ok" role="status">{notice}</p>}
      {say && <RefusalNote refusal={say.refusal} message={say.message} />}

      {b.finalize.shown && (
        <div className="scp-audit__buttons">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!b.save || pending || !dirty} onClick={save}>{busy("save") ? "Saving…" : "Save"}</button>
          {confirm === "finalize" ? (
            <span role="group" aria-label="Confirm finalize" className="scp-audit__buttons">
              <span className="scp-note" style={{ margin: 0 }}>Finalizing freezes this scorecard as a dated record. Nobody can change or delete it afterwards.</span>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={finalize}>{busy("finalize") ? "Finalizing…" : "Yes, finalize"}</button>
              <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={() => setConfirm(null)}>Not yet</button>
            </span>
          ) : (
            <button type="button" className="lux-btn lux-btn--sm" disabled={!b.finalize.allowed || pending} onClick={() => setConfirm("finalize")}>Finalize</button>
          )}
          {b.finalize.reason && confirm !== "finalize" && <span className="scp-field__hint">{b.finalize.reason}</span>}
          {b.remove.shown && (confirm === "delete" ? (
            <span role="group" aria-label="Confirm delete" className="scp-audit__buttons">
              <span className="scp-note" style={{ margin: 0 }}>Delete this draft?</span>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={remove}>{busy("delete") ? "Deleting…" : "Yes, delete it"}</button>
              <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={() => setConfirm(null)}>Keep it</button>
            </span>
          ) : (
            <button type="button" className="lux-btn lux-btn--sm" disabled={!b.remove.allowed || pending} onClick={() => setConfirm("delete")}>Delete draft</button>
          ))}
        </div>
      )}
      {audit.createdBy && <p className="scp-field__hint">Started by {audit.createdBy.name}{audit.createdAt ? ` on ${formatDate(audit.createdAt)}` : ""}.</p>}
    </div>
  );
}
