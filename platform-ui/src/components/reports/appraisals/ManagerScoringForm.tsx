"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { CohortBand } from "@/components/reports/charts/CohortBand";
import {
  APPRAISAL_AXES, AXIS_LABELS, DEVIATION_THRESHOLD, MIN_COMMENTARY_LENGTH,
  checkSubmitReadiness, previewComposite, commentaryRemaining,
  type AppraisalAxis, type AppraisalAxisScore, type AppraisalPack,
} from "@/lib/appraisals";
import type { patchAppraisalScores, submitAppraisal, confirmAppraisalEvidence } from "@/lib/appraisalActions";
import "@/components/forms/forms.css";
import "./appraisals.css";

type PatchFn = typeof patchAppraisalScores;
type SubmitFn = typeof submitAppraisal;
type ConfirmFn = typeof confirmAppraisalEvidence;

// TR-26 — the manager scoring pack. Acceptance bar: "draft -> submit with ENFORCED
// justifications: commentary under 50 chars is refused, and a deviation greater than ±1 band from
// the computed band requires a written per-axis reason. Surface these as clear validation BEFORE
// submit, not as a raw 400 from the server."
//
// `checkSubmitReadiness` (lib/appraisals.ts) is the SAME rule appraisal-engine.ts enforces
// server-side, duplicated deliberately (see that file's header) so this checklist can render live,
// as the manager types, rather than waiting for a failed request. The Submit button itself stays
// disabled until readiness.ok — the server 400 is still there as the authoritative backstop (this
// form does not "trust" its own duplicate rule), but a manager who follows the checklist should
// never actually see it.
export function ManagerScoringForm({ pack, patchAction, submitAction, confirmEvidenceAction }: {
  pack: AppraisalPack;
  patchAction: PatchFn;
  submitAction: SubmitFn;
  confirmEvidenceAction: ConfirmFn;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<Record<AppraisalAxis, AppraisalAxisScore>>(pack.scores);
  const [commentary, setCommentary] = useState(pack.commentary ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const readiness = useMemo(() => checkSubmitReadiness(scores, commentary), [scores, commentary]);
  const composite = useMemo(() => previewComposite(pack.weights, scores), [pack.weights, scores]);

  function setAxisManager(axis: AppraisalAxis, value: number) {
    setScores((prev) => ({ ...prev, [axis]: { ...prev[axis], manager: value } }));
  }
  function setAxisNote(axis: AppraisalAxis, note: string) {
    setScores((prev) => ({ ...prev, [axis]: { ...prev[axis], note } }));
  }

  function onSaveDraft() {
    setError(null);
    startTransition(async () => {
      const scoresPatch: Partial<Record<AppraisalAxis, { manager?: number | null; note?: string }>> = {};
      for (const axis of APPRAISAL_AXES) scoresPatch[axis] = { manager: scores[axis].manager, note: scores[axis].note ?? "" };
      const res = await patchAction(pack.id, { scores: scoresPatch, commentary });
      if (!res.ok) { setError(res.error ?? "Couldn't save — try again."); return; }
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  function onSubmit() {
    setError(null);
    startTransition(async () => {
      const scoresPatch: Partial<Record<AppraisalAxis, { manager?: number | null; note?: string }>> = {};
      for (const axis of APPRAISAL_AXES) scoresPatch[axis] = { manager: scores[axis].manager, note: scores[axis].note ?? "" };
      const patchRes = await patchAction(pack.id, { scores: scoresPatch, commentary });
      if (!patchRes.ok) { setError(patchRes.error ?? "Couldn't save before submitting — try again."); return; }
      const res = await submitAction(pack.id, commentary);
      if (!res.ok) { setError(res.error ?? "Couldn't submit — try again."); return; }
      router.refresh();
    });
  }

  function onConfirmEvidence() {
    setError(null);
    startTransition(async () => {
      const res = await confirmEvidenceAction(pack.id);
      if (!res.ok) { setError(res.error ?? "Couldn't re-confirm evidence — try again."); return; }
      router.refresh();
    });
  }

  return (
    <div className="rc-viz rc-appr-page">
      <header className="rc-appr-head">
        <div>
          <h2 className="rc-appr-head__title">Score {pack.subjectName}&rsquo;s appraisal</h2>
          <div className="rc-appr-head__meta">
            <span>{pack.cycleName}</span>
            <StatusBadge label={pack.status} />
            {pack.roleKey && <span>Role cohort: {pack.roleKey}</span>}
          </div>
        </div>
      </header>

      {pack.evidenceStale && (
        <div className="rc-appr-banner" role="alert">
          <span className="rc-appr-banner__glyph" aria-hidden>!</span>
          <span>
            <strong>Evidence has changed since this appraisal was generated.</strong> Review the numbers below,
            then re-confirm before this can be finalized.
          </span>
          <button type="button" className="rc-appr-btn rc-appr-btn--ghost" onClick={onConfirmEvidence} disabled={pending}>
            Re-confirm evidence
          </button>
        </div>
      )}

      <section className="rc-section">
        <div className="rc-appr-composite">
          <span className="rc-appr-composite__value">{composite === null ? "—" : composite.toFixed(2)}</span>
          <span className="rc-appr-composite__label">Composite preview {composite === null ? "(score every axis to compute)" : "(of 5)"}</span>
        </div>
      </section>

      <section className="rc-section">
        <h3 className="rc-section__title">Axis scores</h3>
        <div className="rc-appr-axes">
          {APPRAISAL_AXES.map((axis) => {
            const s = scores[axis];
            const deviates = s.auto !== null && s.manager !== null && Math.abs(s.manager - s.auto) > DEVIATION_THRESHOLD;
            return (
              <div className="rc-appr-axis" key={axis}>
                <div className="rc-appr-axis__row">
                  <span className="rc-appr-axis__name">{AXIS_LABELS[axis]}</span>
                  <span className="rc-appr-axis__weight">Weight {Math.round((pack.weights[axis] ?? 0) * 100)}%</span>
                </div>
                <div className="rc-appr-axis__row">
                  <span style={{ font: "400 12px var(--font-body)", color: "var(--rc-text-secondary)" }}>
                    Auto (input): <strong>{s.auto === null ? "n/a — no bandable metric" : `${s.auto} of 5`}</strong>
                  </span>
                  <div className="rc-appr-picker" role="group" aria-label={`${AXIS_LABELS[axis]} score`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n} type="button"
                        className={`rc-appr-picker__btn${s.manager === n ? " rc-appr-picker__btn--active" : ""}`}
                        onClick={() => setAxisManager(axis, n)}
                        aria-pressed={s.manager === n}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                {deviates && (
                  <label className="lux-field" style={{ marginTop: 4 }}>
                    <span className="rc-appr-axis__deviation">
                      Deviates &gt;{DEVIATION_THRESHOLD} band from auto — a written reason is required before submit
                    </span>
                    <textarea
                      className="lux-field__control lux-field__control--textarea"
                      value={s.note ?? ""}
                      onChange={(e) => setAxisNote(axis, e.target.value)}
                      placeholder="Why does this score differ from the computed band?"
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {pack.cohortBands.length > 0 && (
        <section className="rc-section">
          <h3 className="rc-section__title">Cohort position (appraisal-safe metrics)</h3>
          <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--rc-text-muted)" }}>
            Each metric is banded 1-5 by percentile within the same role cohort and cycle — never compared
            across roles. A cohort of fewer than 5 people shows the raw value only, never a band or ranking.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {pack.cohortBands.map((b) => (
              <CohortBand key={b.metricKey} data={b} subjectLabel={pack.subjectName} />
            ))}
          </div>
        </section>
      )}

      <section className="rc-section">
        <h3 className="rc-section__title">Commentary</h3>
        <label className="lux-field">
          <textarea
            className="lux-field__control lux-field__control--textarea"
            value={commentary}
            onChange={(e) => setCommentary(e.target.value)}
            placeholder={`At least ${MIN_COMMENTARY_LENGTH} characters — this is read by ${pack.subjectName}, word for word.`}
            rows={5}
          />
        </label>
        <span className={`rc-appr-charcount${readiness.commentaryOk ? "" : " rc-appr-charcount--short"}`}>
          {readiness.commentaryOk ? "Meets the minimum length." : `${commentaryRemaining(commentary)} more character(s) needed.`}
        </span>
      </section>

      <section className="rc-appr-checklist" aria-live="polite">
        <ChecklistItem ok={readiness.incompleteAxes.length === 0} okText="Every axis is scored" pendingText={`Score every axis (${readiness.incompleteAxes.map((a) => AXIS_LABELS[a]).join(", ")} remaining)`} />
        <ChecklistItem ok={readiness.missingDeviationNotes.length === 0} okText="Every band deviation has a written reason" pendingText={`Add a reason for: ${readiness.missingDeviationNotes.map((a) => AXIS_LABELS[a]).join(", ")}`} />
        <ChecklistItem ok={readiness.commentaryOk} okText={`Commentary is at least ${MIN_COMMENTARY_LENGTH} characters`} pendingText={`Commentary needs ${readiness.commentaryRemaining} more character(s)`} />
      </section>

      {error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--rc-critical)" }}>{error}</p>}
      {savedAt && !pending && !error && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--rc-text-muted)" }}>Draft saved.</p>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="rc-appr-btn rc-appr-btn--ghost" onClick={onSaveDraft} disabled={pending}>
          {pending ? "Saving…" : "Save draft"}
        </button>
        <button type="button" className="rc-appr-btn rc-appr-btn--solid" onClick={onSubmit} disabled={pending || !readiness.ok}>
          {pending ? "Submitting…" : "Submit to " + pack.subjectName}
        </button>
      </div>
    </div>
  );
}

function ChecklistItem({ ok, okText, pendingText }: { ok: boolean; okText: string; pendingText: string }) {
  return (
    <div className={`rc-appr-checklist__item rc-appr-checklist__item--${ok ? "ok" : "pending"}`}>
      <span className="rc-appr-checklist__glyph" aria-hidden>{ok ? "✓" : "○"}</span>
      <span>{ok ? okText : pendingText}</span>
    </div>
  );
}
