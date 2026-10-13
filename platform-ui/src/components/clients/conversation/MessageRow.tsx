"use client";
import { formatBytes, type StaffMessage } from "@/lib/conversation";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { formatDateTime } from "@/lib/format";
import { MessageBody } from "./MessageBody";
import "./conversation.css";

// PV4-09 — one message in a thread. Every row carries who wrote it and on which side (words and an edge, never
// colour alone) and the backend's "Client sees this" marker (rendered from `clientVisible`, nothing else).
//
//   - messages are PERMANENT (PV-D34): there is no edit and no remove, so no control for either, and no "edited" or
//     "Message removed" state. A correction is a new message, posted from the composer below the thread;
//   - "Drafted by <agent>" is staff-only provenance for a message sent from an agent's draft; the message itself
//     is authored by the person who sent it.
export function MessageRow({
  message, draftedByName, canWrite, onTurnIntoRequest,
}: {
  message: StaffMessage;
  draftedByName?: string | null;
  canWrite: boolean;
  onTurnIntoRequest?: (m: StaffMessage) => void;
}) {
  const side = message.authorSide;

  return (
    <li
      id={`msg-${message.id}`}
      tabIndex={-1}
      className={`cv-msg cv-msg--${side}`}
      data-message-id={message.id}
      data-side={side}
    >
      <div className="cv-msg__head">
        <span className="cv-msg__who">{message.authorName}</span>
        <span>{side === "client" ? "Client" : "Our team"}</span>
        <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
        <ClientVisibilityMarker clientVisible={message.clientVisible} />
      </div>

      <MessageBody text={message.body} />

      {message.attachments.length > 0 && (
        <ul className="cv-files" aria-label="Attachments">
          {message.attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/files/${a.id}`}>{a.filename}</a> ({formatBytes(a.byteSize)})
            </li>
          ))}
        </ul>
      )}

      {message.draftedBy && (
        <span className="cv-msg__prov">Drafted by {draftedByName ?? "an agent"} (shown to staff only)</span>
      )}

      {canWrite && side === "client" && onTurnIntoRequest && (
        <div className="cv-msg__tools">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onTurnIntoRequest(message)}>Turn into a change request</button>
        </div>
      )}
    </li>
  );
}
