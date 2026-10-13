"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { AttachmentInput, ConvResult } from "@/lib/conversation";
import { MessageComposer } from "./MessageComposer";
import "./conversation.css";

// PV4-09 — "Start a conversation": on one of the client's projects, or in General (the client's one
// client-wide thread; the platform creates it on the first message and lands later ones in it).
// On a project page `fixedProjectId` pins the choice and the picker is not shown.
export function StartConversation({
  clientId, clientName, projects, fixedProjectId, start,
}: {
  clientId: string;
  clientName: string;
  projects: { id: string; name: string }[];
  fixedProjectId?: string;
  start: (input: { clientId: string; projectId?: string | null; subject?: string; body: string; attachments?: AttachmentInput[] }) => Promise<ConvResult<{ threadId: string }>>;
}) {
  const router = useRouter();
  const id = useId();
  const [projectId, setProjectId] = useState<string>(fixedProjectId ?? "");
  const [subject, setSubject] = useState("");

  return (
    <section className="cv-start" aria-label="Start a conversation">
      <h4 className="ch-group__title">Start a conversation with {clientName}</h4>
      {!fixedProjectId && (
        <div className="cv-field">
          <label className="cv-field__label" htmlFor={`${id}-project`}>About</label>
          <select id={`${id}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">General (not tied to a project)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="cv-field">
        <label className="cv-field__label" htmlFor={`${id}-subject`}>Subject (optional)</label>
        <input id={`${id}-subject`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <MessageComposer
        label="First message"
        submitLabel="Start conversation"
        onSubmit={async ({ body, attachments }) => {
          const r = await start({ clientId, projectId: projectId || null, subject, body, attachments });
          if (!r.ok) return r;
          router.push(`/clients/${clientId}/work/conversation/${r.threadId}`);
          return { ok: true };
        }}
      />
    </section>
  );
}
