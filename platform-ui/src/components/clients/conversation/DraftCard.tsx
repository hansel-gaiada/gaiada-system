"use client";
import { useRef, useState } from "react";
import type { ConvResult, StaffDraft } from "@/lib/conversation";
import { bodyError, MAX_BODY_CHARS } from "@/lib/conversation";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { formatDateTime } from "@/lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { MessageBody } from "./MessageBody";
import "./conversation.css";

// PV4-09 — an agent's pending draft: a slip clipped to the thread, in the Internal area's grammar (dashed warning
// edge, tinted, "Not sent" in words). The "Internal" tag is the backend's `clientVisible:false` rendered by the
// shared marker, never decided here (trap 9).
//
// Send is the one act that reaches the client, so it needs a confirm that names the client. The message that
// results is authored by the person who confirms (design decision 4), and the agent is credited to staff only.
export interface DraftActions {
  send: (draftId: string) => Promise<ConvResult<{ messageId: string }>>;
  editDraft: (draftId: string, body: string) => Promise<ConvResult>;
  discard: (draftId: string) => Promise<ConvResult>;
}

export function DraftCard({
  draft, clientName, canWrite, actions, onChanged, onSent,
}: {
  draft: StaffDraft;
  clientName: string;
  canWrite: boolean;
  actions: DraftActions;
  /** Reload after an edit or discard. */
  onChanged: () => Promise<void> | void;
  /** Reload after a send and move focus to the new message. */
  onSent: (messageId: string) => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const who = draft.draftedByName ?? "an agent";

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await actions.send(draft.id);
      if (!r.ok) { setError(r.error); return; }
      setConfirming(false);
      await onSent(r.messageId);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    const bad = bodyError(text);
    if (bad) { setError(bad); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await actions.editDraft(draft.id, text);
      if (!r.ok) { setError(r.error); return; }
      setEditing(false);
      await onChanged();
      requestAnimationFrame(() => editBtnRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await actions.discard(draft.id);
      if (!r.ok) { setError(r.error); return; }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="cv-draft" aria-label={`Draft by ${who}, not sent`} data-draft-id={draft.id}>
      <div className="cv-draft__head">
        <span>Drafted by {who}. Not sent</span>
        <ClientVisibilityMarker clientVisible={draft.clientVisible} />
        <span style={{ fontWeight: 400 }}>{formatDateTime(draft.createdAt)}</span>
      </div>

      {editing ? (
        <div className="cv-field">
          <label className="cv-field__label" htmlFor={`draft-edit-${draft.id}`}>Edit the draft</label>
          <textarea id={`draft-edit-${draft.id}`} ref={editRef} rows={5} value={text} onChange={(e) => setText(e.target.value)} readOnly={busy} />
          <span className={`cv-count${text.length > MAX_BODY_CHARS ? " cv-count--over" : ""}`}>{text.length.toLocaleString("en-GB")} / {MAX_BODY_CHARS.toLocaleString("en-GB")}</span>
        </div>
      ) : (
        <MessageBody text={draft.body} className="cv-draft__body" />
      )}

      {error && !confirming && <p className="cv-error" role="alert">{error}</p>}

      {canWrite ? (
        <div className="cv-row">
          {editing ? (
            <>
              <button type="button" className="lux-btn lux-btn--sm" onClick={saveEdit} disabled={busy}>Save draft</button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setEditing(false); setText(draft.body); setError(null); }} disabled={busy}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="lux-btn lux-btn--sm" onClick={() => { setError(null); setConfirming(true); }} disabled={busy}>Send</button>
              <button type="button" ref={editBtnRef} className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setText(draft.body); setEditing(true); requestAnimationFrame(() => editRef.current?.focus()); }} disabled={busy}>Edit</button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={discard} disabled={busy}>Discard</button>
            </>
          )}
        </div>
      ) : (
        <p className="cv-help">You can read this draft but not send it.</p>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Send this reply to ${clientName}?`}
        confirmLabel={`Send to ${clientName}`}
        onConfirm={send}
        onCancel={() => setConfirming(false)}
        busy={busy}
        error={error}
      >
        <p style={{ margin: 0 }}>
          {clientName} will see this now, as a message from you. You can edit or remove it for 15 minutes; after that it stays.
        </p>
        <blockquote style={{ margin: 0, padding: "8px 12px", borderLeft: "3px solid var(--status-warning)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {draft.body}
        </blockquote>
      </ConfirmDialog>
    </article>
  );
}
