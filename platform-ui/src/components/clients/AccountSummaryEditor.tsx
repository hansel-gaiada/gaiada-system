"use client";
import { useActionState, useState } from "react";
import { saveSummaryNarrativeAction, type ClientReportActionState } from "@/lib/clientReportsActions";
import { NARRATIVE_SOURCE_LABEL, SUMMARY_NARRATIVE_MAX, narrativeState, type NarrativeSource } from "@/lib/clientReports";
import "./billing/billing.css";
import "./accountSummary.css";

// PV7-07 — the narrative editor of a DRAFT account summary (BFF §56.3): a Markdown textarea and Save.
//
// Saving makes the narrative "Written by staff" (the backend sets `narrativeSource` to human); the numbers below it are the
// frozen snapshot and never change. Publish is the row's own button: it renders the PDF from the text AS SAVED, so unsaved
// typing is said out loud ("Unsaved changes. Save before you publish.") and a publish that races a save is refused by the
// platform (`draft_changed`), never published with the wrong words.
export function AccountSummaryEditor(
  { reportId, clientId, narrativeMd, narrativeSource }: { reportId: string; clientId: string; narrativeMd: string; narrativeSource: NarrativeSource },
) {
  const [state, save, saving] = useActionState<ClientReportActionState | null, FormData>(saveSummaryNarrativeAction, null);
  const [text, setText] = useState(narrativeMd);
  const check = narrativeState(text);
  const dirty = text !== narrativeMd;
  const fieldId = `summary-narrative-${reportId}`;
  const hintId = `summary-narrative-hint-${reportId}`;
  return (
    <form action={save} className="as-narrative" aria-label="Edit narrative">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="reportId" value={reportId} />
      <label className="lux-field" htmlFor={fieldId}>
        <span className="lux-field__label">Narrative (Markdown)</span>
        <textarea
          id={fieldId} name="narrativeMd" className="lux-field__control lux-field__control--textarea"
          value={text} onChange={(e) => setText(e.target.value)} maxLength={SUMMARY_NARRATIVE_MAX} disabled={saving}
          aria-describedby={hintId}
        />
        <span id={hintId} className="lux-field__hint">
          The client reads this first. The figures below are frozen; only these words can change.
        </span>
      </label>
      <p className="as-narrative__source">{NARRATIVE_SOURCE_LABEL[narrativeSource]}</p>
      <div className="bl-payment__buttons">
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={saving || !check.canSave || !dirty}>
          {saving ? "Saving…" : "Save narrative"}
        </button>
        {dirty && <span className="bl-reason">Unsaved changes. Save before you publish.</span>}
        {!check.canSave && check.hint && <span className="bl-reason">{check.hint}</span>}
      </div>
      {state && !state.ok && state.error && <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>}
      {state?.ok && state.notice && !dirty && <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>}
    </form>
  );
}
