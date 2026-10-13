"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { portalStartConversation, type PortalActionResult } from "@/lib/portalActions";
import { PortalComposerFields } from "./PortalComposerFields";

// PV4-08 — "Start a conversation": pick where it belongs, give it a subject, write the first message.
//
// WHERE: a project (a new thread on it) or "General" (a client's one running thread; the first message creates it).
// General is PER CLIENT (PV4-13): `generalClients` is the clients where the caller is client-wide, the server's answer
// (`generalClientIds`), never guessed from the project list. A client where they are limited to some projects has no
// General, so it is never offered: a contact client-wide on A and project-scoped on B can start General for A only.
// With several General clients they pick one (it is sent as `clientId`); with exactly one it is sent without a choice.
// Viewers may start one (PV-D24): this form never reads the signing capability.
export function PortalStartConversation({ projects, generalClients, defaultProjectId }: {
  projects: Array<{ id: string; name: string }>;
  /** The clients whose General thread the caller may use. Empty = General is not offered. */
  generalClients: Array<{ id: string; name: string }>;
  defaultProjectId?: string;
}) {
  const canUseGeneral = generalClients.length > 0;
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
        {generalClients.length > 1 && (
          <div className="cp-field">
            <label className="cp-field__label" htmlFor="cv-start-client">Which of your companies? (for General)</label>
            <select id="cv-start-client" className="cp-select" name="clientId" defaultValue={generalClients[0].id} disabled={pending}>
              {generalClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {/* One General client: name it explicitly rather than lean on the server's "your only client-wide client". */}
        {generalClients.length === 1 && <input type="hidden" name="clientId" value={generalClients[0].id} />}
        <div className="cp-field">
          <label className="cp-field__label" htmlFor="cv-start-subject">Subject (optional)</label>
          <input id="cv-start-subject" className="cp-input" name="subject" type="text" maxLength={200} disabled={pending} />
        </div>
      </PortalComposerFields>
    </form>
  );
}
