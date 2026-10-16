"use client";

import { useFormStatus } from "react-dom";

// DW-10d-3: the Customise control's one submit button, which says it is working while its form posts. Applying a choice re-renders the
// whole Overview on the server, which took 14 to 17 s on the live box (2026-10-16), and a button that did nothing visible for that long read
// as broken. The accessible name stays "<verb> <block>" throughout, so a screen reader and the tests name the same button; `aria-busy` and
// the visible "Saving…" carry the state. Without JavaScript the form still posts and the page redraws (the server action is the same).
export function CustomiseSubmit({ verb, label }: { verb: string; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="ov-custom__btn" aria-label={`${verb} ${label}`} aria-busy={pending || undefined} disabled={pending}>
      {pending ? "Saving…" : verb}
    </button>
  );
}
