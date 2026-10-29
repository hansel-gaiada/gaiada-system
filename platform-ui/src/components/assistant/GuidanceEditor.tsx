"use client";
import { useId, useState, type FormEvent } from "react";
import { savePreambleAction } from "@/lib/assistantGuidanceActions";
import {
  GUIDANCE_OFF_NOTE, GUIDANCE_SECRET_NOTE, PREAMBLE_MAX, changedLine, countLabel, lengthState, measuredText, startingText,
  type PreambleView,
} from "@/lib/assistantGuidance";
import "@/components/forms/forms.css";
import "./guidance.css";

// AIP-13b (BFF §65, owner ruling AIP-D10): the department's assistant guidance. The text the assistant reads for this department, edited by its
// head (and a company admin and the owner), shown with the exact block the assistant reads and who changed it last. It is only OFFERED to a
// person who may edit (`mayEditPreamble`, a mirror: `canEdit`); the server decides every write, and its refusals are said as the form's error.
//
// The text is a controlled field and is never reset by a refusal: what the person typed stays until a save succeeds. The saved state is the
// SERVER's answer (the PUT returns the new §65.1 view), so "What the assistant reads" is the server's `preview`, never composed here.

export function GuidanceEditor({ tenantId, view: initial, canEdit }: { tenantId: string; view: PreambleView; canEdit: boolean }) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const countId = `${uid}-count`;
  const noteId = `${uid}-note`;
  const errId = `${uid}-err`;
  const previewId = `${uid}-preview`;
  const [view, setView] = useState<PreambleView>(initial);
  const [text, setText] = useState(startingText(initial));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // One flag, flipped in the same batch as the result, so the button never reads "Saving…" beside a finished save (a transition's own `isPending` settles a render later).
  const [pending, setPending] = useState(false);

  const len = lengthState(text);
  const baseline = startingText(view);
  // Saving what is already in force changes nothing (and would freeze the default as the company's own text), so it is not offered.
  const unchanged = measuredText(text) === measuredText(baseline);
  const canSave = len.ok && !unchanged && !pending;
  const hasCustom = view.custom !== null;

  const run = async (body: string, done: string) => {
    setError(null);
    setStatus("");
    setPending(true);
    try {
      const res = await savePreambleAction(tenantId, view.unitNodeId, body);
      if (res.ok) {
        setView(res.view);
        setText(startingText(res.view));
        setStatus(done);
      } else {
        setError(res.error);
      }
    } catch {
      setError("The text could not be saved just now. Try again.");
    } finally {
      setPending(false);
    }
  };

  // A plain submit handler, not the form's `action`: React 19 resets an uncontrolled form once its action finishes, and a refusal must not
  // wipe the text the person just wrote.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSave) return;
    void run(text, measuredText(text) === "" ? "Back to the default." : "Saved.");
  };

  const readOnly = !canEdit;
  return (
    <div className="ag">
      <p className={`ag-state${hasCustom ? " ag-state--own" : ""}`} data-state={hasCustom ? "custom" : "default"}>
        {hasCustom
          ? <>{view.department?.name ?? "This department"} uses the <strong>company&apos;s own text</strong>.</>
          : view.defaultText !== null
            ? <>{view.department?.name ?? "This department"} uses the <strong>default text</strong>. Edit it to make it your own.</>
            : <>{view.department?.name ?? "This department"} has <strong>no default text</strong>, so the assistant gets only the department&apos;s name until you write some.</>}
      </p>
      {!view.contextEnabled && <p className="ag-off" role="note" data-context="off">{GUIDANCE_OFF_NOTE}</p>}

      {canEdit ? (
        <form onSubmit={onSubmit} className="ag-form" aria-label="Department guidance">
          <label className="lux-field">
            <span id={labelId} className="lux-field__label">What the assistant should know about this department</span>
            <textarea
              name="body"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={9}
              aria-labelledby={labelId}
              aria-describedby={[countId, noteId, error ? errId : ""].filter(Boolean).join(" ")}
              aria-invalid={!len.ok || error ? true : undefined}
              className={`lux-field__control lux-field__control--textarea${!len.ok ? " lux-field__control--error" : ""}`}
              disabled={pending}
            />
          </label>
          <p id={countId} className={`ag-count${len.ok ? "" : " ag-count--over"}`} data-over={len.ok ? undefined : "true"}>{countLabel(text)}</p>
          <p id={noteId} className="ag-note">{GUIDANCE_SECRET_NOTE}</p>
          <div className="ag-actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!canSave}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="lux-btn lux-btn--ghost lux-btn--sm"
              disabled={!hasCustom || pending}
              onClick={() => void run("", "Back to the default.")}
            >
              Use the default
            </button>
            {error && <span id={errId} role="alert" className="ag-msg ag-msg--bad">{error}</span>}
          </div>
        </form>
      ) : (
        <>
          <p className="ag-note" id={noteId}>{GUIDANCE_SECRET_NOTE}</p>
          <p className="ag-note" data-readonly="true">You can see this text but not change it. Only this department&apos;s head or a company admin can.</p>
        </>
      )}
      {/* Always rendered, so a screen reader hears the change: it is empty until a save or a reset has happened. */}
      <p role="status" aria-live="polite" className="ag-status" data-status={status || undefined}>{status}</p>

      <section className="ag-preview-wrap" aria-labelledby={`${previewId}-h`}>
        <h4 id={`${previewId}-h`} className="ag-h">What the assistant reads</h4>
        {view.preview !== null
          ? <pre id={previewId} className="ag-preview" tabIndex={0} aria-labelledby={`${previewId}-h`}>{view.preview}</pre>
          : <p className="ag-note">Nothing: the assistant gets no department text for this department.</p>}
        <p className="ag-meta">{changedLine(view)}</p>
        {canEdit && <p className="ag-meta">Up to {PREAMBLE_MAX.toLocaleString("en-US")} characters. Line breaks are kept; formatting is not.</p>}
      </section>
    </div>
  );
}
