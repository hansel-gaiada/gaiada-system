"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

// A two-step button for an act that puts content live (Publish now, Approve): the first press asks, the second does it.
// Inline rather than a modal, so there is nothing to trap: focus moves to the confirming button when the question
// appears, and returns to the button that asked when it is cancelled. The question is announced politely.
//
// `testId` names the first button; the confirming one is `${testId}-confirm`, the cancel `${testId}-cancel`.
export function ConfirmAction({
  label, question, confirmLabel, busy = false, disabled = false, describedBy, testId, onConfirm, variant = "solid", ariaLabel,
}: {
  label: string;
  /** "Publish v4 of this page now? It goes live on your site." */
  question: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  disabled?: boolean;
  describedBy?: string;
  testId: string;
  onConfirm: () => void | Promise<void>;
  variant?: "solid" | "ghost";
  /** An accessible name that says WHICH thing (a row's button is "Publish Home page now", not just "Publish now"). */
  ariaLabel?: string;
}) {
  const [asking, setAsking] = useState(false);
  const askRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (wasAsking.current) askRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  if (!asking) {
    return (
      <button
        ref={askRef} type="button" className={`lux-btn lux-btn--${variant} lux-btn--sm`} data-testid={testId}
        disabled={disabled || busy} aria-describedby={describedBy} aria-label={ariaLabel} onClick={() => setAsking(true)}
      >
        {busy ? "Working…" : label}
      </button>
    );
  }
  return (
    <span role="group" aria-label={ariaLabel ? `Confirm: ${ariaLabel}` : "Confirm"} className="wc-publish__actions" data-testid={`${testId}-ask`}>
      <span role="status" className="wc-publish__sub">{question}</span>
      <button
        ref={confirmRef} type="button" className="lux-btn lux-btn--solid lux-btn--sm" data-testid={`${testId}-confirm`}
        disabled={busy} onClick={async () => { await onConfirm(); setAsking(false); }}
      >
        {busy ? "Working…" : confirmLabel}
      </button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" data-testid={`${testId}-cancel`} disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}
