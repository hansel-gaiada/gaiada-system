"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/overlay/Modal";
import { KIND_LABEL, KINDS, type CrKind } from "@/lib/webdevChangeRequests";
import type { ConvResult, StaffMessage, StaffThread } from "@/lib/conversation";
import "./conversation.css";

// PV4-09 — "Turn into a change request": the request form, prefilled from a client's message, with the message's
// id sent as `sourceMessageId` so the request keeps the words it came from. The staff app had no request-create
// form before this (the portal has its own), so this is the minimal one: a kind, a title and a body.
//
// The platform accepts `sourceMessageId` only for a message in a thread of the request's own client; this form
// always sends the thread's client, so a refusal here means the message was removed meanwhile.
export interface CreateRequestInput {
  kind: string; title: string; body: string; clientId: string; projectId: string | null; sourceMessageId: string;
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 100);

export function ChangeRequestFromMessage({
  message, thread, create, onClose,
}: {
  message: StaffMessage;
  thread: Pick<StaffThread, "clientId" | "projectId">;
  create: (input: CreateRequestInput) => Promise<ConvResult<{ requestId: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<CrKind>("feature");
  const [title, setTitle] = useState(firstLine(message.body ?? ""));
  const [body, setBody] = useState((message.body ?? "").slice(0, 5000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setError("Give the request a title."); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await create({ kind, title, body, clientId: thread.clientId, projectId: thread.projectId, sourceMessageId: message.id });
      if (r.ok) setCreated(true); else setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Turn into a change request" size="md">
      {created ? (
        <div style={{ display: "grid", gap: 12 }}>
          <p role="status" style={{ margin: 0 }}>
            The request was created and is waiting for triage. It keeps a link to this message.{" "}
            <Link href={`/clients/${thread.clientId}/work#requests`}>See this client&apos;s requests</Link>
          </p>
          <div className="cv-row"><button type="button" className="lux-btn lux-btn--sm" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }} aria-label="New change request">
          <div className="cv-field">
            <label className="cv-field__label" htmlFor={`${id}-kind`}>Kind</label>
            <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as CrKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>
          <div className="cv-field">
            <label className="cv-field__label" htmlFor={`${id}-title`}>Title</label>
            <input id={`${id}-title`} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="cv-field">
            <label className="cv-field__label" htmlFor={`${id}-body`}>Details (from the client&apos;s message)</label>
            <textarea id={`${id}-body`} rows={6} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
          </div>
          {error && <p className="cv-error" role="alert">{error}</p>}
          <div className="cv-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="lux-btn lux-btn--sm" disabled={busy}>{busy ? "Creating…" : "Create request"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
