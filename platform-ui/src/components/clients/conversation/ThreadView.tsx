"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  draftedByNames, newClientMessages, pendingDrafts, threadScope, threadTitle,
  type AttachmentInput, type ConvResult, type StaffDraft, type StaffMessage, type ThreadSnapshot,
} from "@/lib/conversation";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ChangeRequestFromMessage, type CreateRequestInput } from "./ChangeRequestFromMessage";
import { DraftCard, type DraftActions } from "./DraftCard";
import { MessageComposer, type ComposerHandle } from "./MessageComposer";
import { MessageRow } from "./MessageRow";
import { useThreadPolling } from "./useThreadPolling";
import "./conversation.css";

// PV4-09 — one conversation thread, as staff see it.
//
//   - messages oldest first, each with its sender, side and the backend's "Client sees this" marker. Messages are
//     permanent (PV-D34): no edit, no remove, a correction is a new message;
//   - a distinct Internal-styled card for every pending agent draft (Send needs a confirm that names the client);
//   - a composer (plain text, attachments), Close and Reopen, and "Turn into a change request";
//   - fresh every 20 s while the page is visible and on window focus (`useThreadPolling`): there is no staff live
//     channel (design decision 6).
//
// ── ACCESSIBILITY ────────────────────────────────────────────────────────────────────────────────
// The history is NOT `role="log"`: a live region over the whole history would read it all out on every poll
// (memory `role-log-is-a-live-region`). Only what is NEW is announced, politely, through one small status region,
// and only a client's message or a freshly waiting draft: never your own writes. After a send the composer keeps
// focus; after a draft is sent focus moves to the message it became; after a confirm closes, focus returns to the
// control that opened it (Modal).

export interface ThreadActions extends DraftActions {
  load: (threadId: string) => Promise<ConvResult<{ snapshot: ThreadSnapshot }>>;
  post: (threadId: string, clientId: string, input: { body: string; attachments?: AttachmentInput[] }) => Promise<ConvResult<{ messageId: string }>>;
  setStatus: (threadId: string, clientId: string, status: "open" | "closed") => Promise<ConvResult>;
  createChangeRequest: (input: CreateRequestInput) => Promise<ConvResult<{ requestId: string }>>;
}

export function ThreadView({
  initial, canWrite, actions, pollMs,
}: {
  initial: ThreadSnapshot;
  /** Cosmetic gate (client.write mirrors the Cerbos post/draft/manage roles). The platform decides. */
  canWrite: boolean;
  actions: ThreadActions;
  pollMs?: number;
}) {
  const [snap, setSnap] = useState<ThreadSnapshot>(initial);
  const [announce, setAnnounce] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [requestFor, setRequestFor] = useState<StaffMessage | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const { thread, messages, drafts } = snap;
  const threadId = thread.id;
  const clientId = thread.clientId;

  const reload = useCallback(async () => {
    const r = await actions.load(threadId);
    if (!r.ok) { setLoadError(r.error); return; }
    setLoadError(null);
    const prev = snapRef.current;
    const fresh = newClientMessages(prev.messages, r.snapshot.messages);
    const knownDrafts = new Set(prev.drafts.map((d: StaffDraft) => d.id));
    const freshDrafts = pendingDrafts(r.snapshot.drafts).filter((d) => !knownDrafts.has(d.id));
    // A repeat of the same sentence gets an invisible suffix so the status region still changes and re-announces.
    const say = (t: string) => setAnnounce((prevText) => (prevText === t ? `${t}​` : t));
    if (fresh.length > 0) say(fresh.length === 1 ? `New message from ${fresh[0].authorName}` : `${fresh.length} new messages from the client`);
    else if (freshDrafts.length > 0) say("A draft reply is waiting");
    setSnap(r.snapshot);
  }, [actions, threadId]);

  useThreadPolling(reload, { intervalMs: pollMs });

  // Move focus to a message after a draft was sent, once the reload has put it in the list.
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`msg-${focusId}`);
    if (el) { el.focus(); setFocusId(null); }
  }, [focusId, messages]);

  const names = draftedByNames(drafts);
  const waiting = pendingDrafts(drafts);
  const closed = thread.status === "closed";

  const toggleStatus = async () => {
    setStatusError(null);
    const r = await actions.setStatus(threadId, clientId, closed ? "open" : "closed");
    if (!r.ok) { setStatusError(r.error); return; }
    await reload();
  };

  return (
    <div className="cv-thread">
      <div className="cv-thread__head">
        <div>
          <h2 className="cv-thread__title">{threadTitle(thread)}</h2>
          <p className="cv-help">
            {threadScope(thread)} · {closed ? "Closed" : "Open"}
            <ClientVisibilityMarker clientVisible={thread.clientVisible} />
          </p>
        </div>
        {canWrite && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={toggleStatus}>
            {closed ? "Reopen conversation" : "Close conversation"}
          </button>
        )}
      </div>
      {statusError && <p className="cv-error" role="alert">{statusError}</p>}
      {loadError && <p className="cv-error" role="alert">The conversation could not be refreshed: {loadError}</p>}

      {/* announced politely, new items only; the history itself is not a live region */}
      <div className="cv-sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>

      {messages.length === 0 ? (
        <EmptyNote>No messages yet.</EmptyNote>
      ) : (
        <ol className="cv-messages" aria-label="Messages, oldest first">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              draftedByName={names.get(m.id) ?? null}
              canWrite={canWrite}
              onTurnIntoRequest={canWrite ? setRequestFor : undefined}
            />
          ))}
        </ol>
      )}

      {waiting.length > 0 && (
        <section aria-label="Draft replies waiting for you" style={{ display: "grid", gap: 12 }}>
          {waiting.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              clientName={thread.clientName}
              canWrite={canWrite}
              actions={actions}
              onChanged={reload}
              onSent={async (messageId) => { await reload(); setFocusId(messageId); }}
            />
          ))}
        </section>
      )}

      {closed ? (
        <p className="cv-closed">This conversation is closed. {canWrite ? "Reopen it to reply." : "A teammate can reopen it."}</p>
      ) : canWrite ? (
        <MessageComposer
          ref={composerRef}
          label="Reply to the client"
          submitLabel="Send reply"
          onSubmit={async (input) => {
            const r = await actions.post(threadId, clientId, input);
            if (!r.ok) return r;
            await reload();
            return { ok: true };
          }}
        />
      ) : (
        <p className="cv-help">You can read this conversation but not reply to it.</p>
      )}

      {requestFor && (
        <ChangeRequestFromMessage
          message={requestFor}
          thread={thread}
          create={actions.createChangeRequest}
          onClose={() => setRequestFor(null)}
        />
      )}
    </div>
  );
}
