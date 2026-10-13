"use client";
import { useEffect, useRef, useState } from "react";
import {
  attachmentProblem, CONVERSATION_BODY_MAX, CONVERSATION_COUNTER_FROM, CONVERSATION_MAX_BYTES,
  CONVERSATION_MAX_FILES, CONVERSATION_PERMANENT_HINT, CONVERSATION_PRICE_HINT, formatBytes,
} from "@/lib/portal";

// PV4-08 — the message box shared by "Start a conversation" and the thread's reply form. It renders INSIDE a
// <form> the parent owns (the parent's `useActionState` action reads `body` and the `attachments` files from the
// FormData), so there is exactly one place the composer's rules live.
//
// Rules (FRONTEND-BFF-CONTRACT §29): plain text, 1..10,000 characters; at most 5 files and 10 MB in total. All
// of it is checked here first, in plain words, so a client is never sent to a server refusal for something this
// screen could have said. The server enforces the same limits and stays the authority.
//
// NO maxLength on the textarea, on purpose: it truncates a long paste silently, and a client who pastes a long
// brief should SEE that it is too long (the counter turns to a warning and Send is held) rather than lose the end
// of it without being told.

export function PortalComposerFields({
  idPrefix, bodyLabel, submitLabel, pendingLabel, pending, error, errorField, focusOnMount = false, children,
}: {
  idPrefix: string;
  bodyLabel: string;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  /** The server's refusal, shown above the box. */
  error?: string;
  errorField?: string;
  /** Move focus to the box when this mounts: the reply form remounts after a successful send. */
  focusOnMount?: boolean;
  /** Extra fields shown above the message box (Start a conversation: project, subject). */
  children?: React.ReactNode;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) area.current?.focus();
  }, [focusOnMount]);

  const over = body.length - CONVERSATION_BODY_MAX;
  const showCount = body.length >= CONVERSATION_COUNTER_FROM;
  const fileProblem = attachmentProblem(files);
  const blocked = pending || body.trim().length === 0 || over > 0 || fileProblem !== null;

  // Rebuild the input's own file list so what is SUBMITTED matches what is listed. DataTransfer is the only way to
  // edit a FileList; where it is missing the whole selection is cleared instead, which is still honest.
  function removeFile(index: number) {
    const next = files.filter((_, i) => i !== index);
    const input = picker.current;
    if (input) {
      try {
        const dt = new DataTransfer();
        next.forEach((f) => dt.items.add(f));
        input.files = dt.files;
      } catch {
        input.value = "";
        setFiles([]);
        return;
      }
    }
    setFiles(next);
  }

  return (
    <>
      {error && (
        <div className="cp-form__error" role="alert" id={`${idPrefix}-error`}>{error}</div>
      )}
      {children}
      <div className="cp-field">
        <label className="cp-field__label" htmlFor={`${idPrefix}-body`}>{bodyLabel}</label>
        <textarea
          id={`${idPrefix}-body`} ref={area} className="cp-textarea" name="body" rows={4}
          value={body} onChange={(e) => setBody(e.target.value)} disabled={pending}
          aria-invalid={over > 0 || errorField === "body" ? true : undefined}
          aria-describedby={`${idPrefix}-hint ${idPrefix}-permanent${showCount ? ` ${idPrefix}-count` : ""}`}
        />
        <span className="cp-field__hint" id={`${idPrefix}-hint`}>{CONVERSATION_PRICE_HINT}</span>
        <span className="cp-field__hint" id={`${idPrefix}-permanent`}>{CONVERSATION_PERMANENT_HINT}</span>
        {showCount && (
          <span
            id={`${idPrefix}-count`} role="status"
            className={`cp-composer__count${over > 0 ? " cp-composer__count--over" : ""}`}
          >
            {over > 0
              ? `${body.length.toLocaleString("en-US")} of ${CONVERSATION_BODY_MAX.toLocaleString("en-US")} characters. Shorten it by ${over.toLocaleString("en-US")}.`
              : `${body.length.toLocaleString("en-US")} of ${CONVERSATION_BODY_MAX.toLocaleString("en-US")} characters`}
          </span>
        )}
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor={`${idPrefix}-files`}>
          Attach files (optional)
        </label>
        <input
          id={`${idPrefix}-files`} ref={picker} className="cp-input" type="file" name="attachments" multiple
          disabled={pending} aria-describedby={`${idPrefix}-files-hint${fileProblem ? ` ${idPrefix}-files-problem` : ""}`}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <span className="cp-field__hint" id={`${idPrefix}-files-hint`}>
          Up to {CONVERSATION_MAX_FILES} files, {formatBytes(CONVERSATION_MAX_BYTES)} in total.
        </span>
        {files.length > 0 && (
          <ul className="cp-composer__files" aria-label="Files to send">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="cp-composer__row">
                <span>{f.name} ({formatBytes(f.size)})</span>
                <button type="button" className="cp-linkbtn" onClick={() => removeFile(i)} disabled={pending}
                        aria-label={`Remove ${f.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {fileProblem && (
          <div className="cp-form__error" role="alert" id={`${idPrefix}-files-problem`}>{fileProblem}</div>
        )}
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={blocked}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
    </>
  );
}
