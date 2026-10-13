"use client";
import { forwardRef, useId, useImperativeHandle, useRef, useState } from "react";
import {
  COMPOSER_HINT, COMPOSER_PERMANENT_HINT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_BODY_CHARS,
  attachmentsError, bodyError, formatBytes, type AttachmentInput,
} from "@/lib/conversation";
import "./conversation.css";

// PV4-09 — the staff composer: plain text, at most 10,000 characters, up to 5 files and 10 MB in total.
//
// It owns the draft text and the picked files, and hands `{body, attachments}` to `onSubmit`. On success it
// clears itself and puts focus back in the text box (so someone replying twice keeps typing); on failure it keeps
// everything, so a refused send never loses what was written. The limits are the platform's, repeated here only to
// save a round trip.
//
// Files are read in the browser to base64 and travel as JSON to the server action. The platform's per-route body
// limit (BFF §29) admits a 10 MB total.

export interface ComposerHandle { focus(): void }

async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`${file.name} could not be read.`));
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.readAsDataURL(file);
  });
}

export const MessageComposer = forwardRef<ComposerHandle, {
  onSubmit: (input: { body: string; attachments: AttachmentInput[] }) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitLabel: string;
  label: string;
  /** Show the contract-and-terms hint (§2.4). On for every composer that writes to a client. */
  showHint?: boolean;
  placeholder?: string;
  initialBody?: string;
}>(function MessageComposer({ onSubmit, submitLabel, label, showHint = true, placeholder, initialBody = "" }, ref) {
  const id = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState(initialBody);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => textRef.current?.focus() }));

  const over = body.length > MAX_BODY_CHARS;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const b = bodyError(body) ?? attachmentsError(files.map((f) => ({ name: f.name, size: f.size })));
    if (b) { setError(b); return; }
    setBusy(true);
    setError(null);
    try {
      const attachments: AttachmentInput[] = await Promise.all(
        files.map(async (f) => ({ filename: f.name, contentType: f.type || "application/octet-stream", content: await toBase64(f) })),
      );
      const r = await onSubmit({ body, attachments });
      if (r.ok) {
        setBody("");
        setFiles([]);
        if (fileRef.current) fileRef.current.value = "";
        textRef.current?.focus();
      } else {
        setError(r.error);
      }
    } catch (err) {
      setError((err as Error).message || "That did not send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cv-composer" onSubmit={submit}>
      <div className="cv-field">
        <label className="cv-field__label" htmlFor={`${id}-body`}>{label}</label>
        <textarea
          id={`${id}-body`}
          ref={textRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          readOnly={busy}
        />
      </div>
      <div className="cv-row">
        <p id={`${id}-hint`} className="cv-help">
          Plain text. {showHint ? COMPOSER_HINT : null}{showHint ? <>{" "}<span>{COMPOSER_PERMANENT_HINT}</span></> : null}
        </p>
        <span className={`cv-count${over ? " cv-count--over" : ""}`} aria-live="off">
          {body.length.toLocaleString("en-GB")} / {MAX_BODY_CHARS.toLocaleString("en-GB")}
        </span>
      </div>
      <div className="cv-field">
        <label className="cv-field__label" htmlFor={`${id}-files`}>
          Attach files (up to {MAX_ATTACHMENTS}, {formatBytes(MAX_ATTACHMENT_BYTES)} in total)
        </label>
        <input
          id={`${id}-files`}
          ref={fileRef}
          type="file"
          multiple
          disabled={busy}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {files.length > 0 && (
          <ul className="cv-composer__files" aria-label="Files to attach">
            {files.map((f, i) => <li key={`${f.name}-${i}`}>{f.name} ({formatBytes(f.size)})</li>)}
          </ul>
        )}
      </div>
      {error && <p className="cv-error" role="alert">{error}</p>}
      <div className="cv-row">
        <button type="submit" className="lux-btn lux-btn--sm" disabled={busy}>{busy ? "Sending…" : submitLabel}</button>
      </div>
    </form>
  );
});
