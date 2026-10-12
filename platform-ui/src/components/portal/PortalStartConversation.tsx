"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { portalStartConversation, type PortalActionResult } from "@/lib/portalActions";
import { PortalComposerFields } from "./PortalComposerFields";

// PV4-08 — "Start a conversation": pick where it belongs, give it a subject, write the first message.
//
// WHERE: a project (a new thread on it) or, for a client-wide contact only, "General" (the client's one running
// thread; the first message creates it). `canUseGeneral` is the server's answer, never guessed from the project list.
// A contact of several clients picks the client for General (`clients`); with one client there is nothing to pick.
// Viewers may start one (PV-D24): this form never reads the signing capability.
export function PortalStartConversation({ projects, canUseGeneral, clients, defaultProjectId }: {
  projects: Array<{ id: string; name: string }>;
  canUseGeneral: boolean;
  /** The caller's clients, only needed when there is more than one (it names the client for General). */
  clients: Array<{ id: string; name: string }>;
  defaultProjectId?: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalStartConversation, null);

  // On success the new thread is the next place to be.
  useEffect(() => {
    if (state?.ok && state.id) router.push(`/portal/conversation/${state.id}`);
  }, [state, router]);

  const nowhere = !canUseGeneral && projects.length === 0;
  if (nowhere) {
    return <p className="cp-field__hint">There is no project on your account to start a conversation about yet. Ask your account manager.</p>;
  }
  const initial = defaultProjectId && projects.some((p) => p.id === defaultProjectId)
    ? defaultProjectId
    : canUseGeneral ? "" : projects[0]?.id ?? "";

  return (
    <form action={formAction} className="cp-form cp-composer" aria-label="Start a conversation">
      <PortalComposerFields
        idPrefix="cv-start" bodyLabel="Your message" submitLabel="Start conversation" pendingLabel="Sending…"
        pending={pending} error={state && !state.ok ? state.error : undefined} errorField={state?.field}
      >
        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cv-start-project">What is it about?</label>
          <select id="cv-start-project" className="cp-select" name="projectId" defaultValue={initial} disabled={pending}>
            {canUseGeneral && <option value="">General (your whole account)</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {canUseGeneral && clients.length > 1 && (
          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cv-start-client">Which of your companies? (for General)</label>
            <select id="cv-start-client" className="cp-select" name="clientId" defaultValue={clients[0].id} disabled={pending}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cv-start-subject">Subject (optional)</label>
          <input id="cv-start-subject" className="cp-input" name="subject" type="text" maxLength={200} disabled={pending} />
        </div>
      </PortalComposerFields>
    </form>
  );
}
