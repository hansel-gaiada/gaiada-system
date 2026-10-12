"use client";
import { useActionState } from "react";
import { portalPostMessage, type PortalActionResult } from "@/lib/portalActions";
import { PortalComposerFields } from "./PortalComposerFields";

// PV4-08 — reply in a thread. A viewer-capability contact may reply (PV-D24): nothing here reads the signing
// capability, by construction (the same rule as PortalChangeRequestForm).
//
// After a successful send the form is REMOUNTED (keyed on the new message's id) so the box and the file list are
// empty, and the new instance moves focus into the box: the next thing a person does after sending is usually
// to keep typing, and a remount that dropped focus to <body> would strand a keyboard or screen-reader user at the
// top of the page. The sent message itself is announced by the thread's status region, not here.
export function PortalReplyForm({ threadId }: { threadId: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalPostMessage, null);
  const sent = state?.ok === true;
  return (
    <form action={formAction} className="cp-form cp-composer" key={state?.id ?? "initial"} aria-label="Reply to this conversation">
      <input type="hidden" name="threadId" value={threadId} />
      <PortalComposerFields
        idPrefix="cv-reply" bodyLabel="Your reply" submitLabel="Send reply" pendingLabel="Sending…"
        pending={pending} error={state && !state.ok ? state.error : undefined} errorField={state?.field}
        focusOnMount={sent}
      />
    </form>
  );
}
