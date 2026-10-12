"use client";
import { useState } from "react";
import { bodyError, canEditNow, formatBytes, type ConvResult, type StaffMessage } from "@/lib/conversation";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { formatDateTime } from "@/lib/format";
import { MessageBody } from "./MessageBody";
import "./conversation.css";

// PV4-09 — one message in a thread. Every row carries who wrote it and on which side (words and an edge, never
// colour alone) and the backend's "Client sees this" marker (rendered from `clientVisible`, nothing else).
//
//   - "edited" and "Message removed" are states the backend reports (`edited`, `retracted`); a removed message has
//     no body to show;
//   - edit and retract are offered for your own message while the SERVER's `editableUntil` is in the future. The
//     server enforces the 15 minutes (409); the UI only avoids offering a control that is certain to be refused;
//   - "Drafted by <agent>" is staff-only provenance for a message sent from an agent's draft; the message itself
//     is authored by the person who sent it.
export interface MessageActions {
  edit: (messageId: string, body: string) => Promise<ConvResult>;
  retract: (messageId: string) => Promise<ConvResult>;
}

export function MessageRow({
  message, draftedByName, canWrite, actions, onChanged, onTurnIntoRequest, now,
}: {
  message: StaffMessage;
  draftedByName?: string | null;
  canWrite: boolean;
  actions: MessageActions;
  onChanged: () => Promise<void> | void;
  onTurnIntoRequest?: (m: StaffMessage) => void;
  now?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const side = message.authorSide;
  const removed = message.retracted;
  const editable = canWrite && canEditNow(message, now);

  const run = async (fn: () => Promise<ConvResult>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) { setError(r.error); return; }
      after?.();
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const bad = bodyError(text);
    if (bad) { setError(bad); return; }
    void run(() => actions.edit(message.id, text), () => setEditing(false));
  };

  return (
    <li
      id={`msg-${message.id}`}
      tabIndex={-1}
      className={`cv-msg cv-msg--${side}${removed ? " cv-msg--removed" : ""}`}
      data-message-id={message.id}
      data-side={side}
    >
      <div className="cv-msg__head">
        <span className="cv-msg__who">{message.authorName}</span>
        <span>{side === "client" ? "Client" : "Our team"}</span>
        <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
        {message.edited && !removed && <span>edited</span>}
        <ClientVisibilityMarker clientVisible={message.clientVisible} />
      </div>

      {removed ? (
        <p className="cv-msg__body">Message removed</p>
      ) : editing ? (
        <div className="cv-field">
          <label className="cv-field__label" htmlFor={`edit-${message.id}`}>Edit your message</label>
          <textarea id={`edit-${message.id}`} rows={4} value={text} onChange={(e) => setText(e.target.value)} readOnly={busy} />
        </div>
      ) : (
        <MessageBody text={message.body ?? ""} />
      )}

      {!removed && message.attachments.length > 0 && (
        <ul className="cv-files" aria-label="Attachments">
          {message.attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/files/${a.id}`}>{a.filename}</a> ({formatBytes(a.byteSize)})
            </li>
          ))}
        </ul>
      )}

      {!removed && message.draftedBy && (
        <span className="cv-msg__prov">Drafted by {draftedByName ?? "an agent"} (shown to staff only)</span>
      )}

      {error && <p className="cv-error" role="alert">{error}</p>}

      {!removed && (editable || (canWrite && side === "client" && onTurnIntoRequest)) && (
        <div className="cv-msg__tools">
          {editing ? (
            <>
              <button type="button" className="lux-btn lux-btn--sm" onClick={save} disabled={busy}>Save message</button>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setEditing(false); setText(message.body ?? ""); setError(null); }} disabled={busy}>Cancel</button>
            </>
          ) : (
            <>
              {editable && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setText(message.body ?? ""); setEditing(true); }} disabled={busy}>Edit</button>}
              {editable && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => run(() => actions.retract(message.id))} disabled={busy}>Remove</button>}
              {side === "client" && onTurnIntoRequest && (
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onTurnIntoRequest(message)}>Turn into a change request</button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
