"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import type { FinanceActionResult } from "@/lib/financeActions";

// The gate in front of an action that cannot be undone by an ordinary correction.
//
// ── TYPE THE NAME, NOT "YES" ───────────────────────────────────────────────────────────────────
// The reader must echo the object's own name — the period, the cutover date, the fiscal year, the
// instrument code — before the button arms. That is deliberately more effort than a dialog, for a
// reason a dialog cannot serve: an "are you sure?" is dismissed by reflex, and reflex is exactly
// what should not close a period. Typing "Aug 2026" requires having READ which period is about to
// close, which is the one thing a mis-click cannot supply.
//
// ── THE SERVER CHECKS IT TOO, AND THAT IS THE REAL GUARANTEE ───────────────────────────────────
// This component is an affordance, not a boundary. Every one of these endpoints re-validates the
// confirmation string server-side and re-runs its readiness gate there, because a confirmation that
// lives only in a browser protects nobody calling the API directly — including an agent, which this
// program expects to have. If this file were deleted the actions would still be gated.
//
// ── IT SAYS WHAT WILL HAPPEN, NOT THAT IT IS DANGEROUS ─────────────────────────────────────────
// `consequence` is a sentence about the world after the click ("the ledger stops accepting entries
// dated inside this period"), never a warning adjective. "This is irreversible!" tells a reader to
// be nervous; it does not tell them what they are about to do.
export interface ConfirmActionProps {
  /** The exact string the reader must type. Compared case-sensitively by the server. */
  expected: string;
  /** What `expected` IS, for the field label — "period", "cutover date", "fiscal year". */
  expectedLabel: string;
  /** What the world looks like afterwards. A sentence, not a warning. */
  consequence: string;
  actionLabel: string;
  /** When true, a free-text reason is required and passed to `run`. */
  requireReason?: boolean;
  reasonHint?: string;
  run: (input: { confirm: string; reason?: string }) => Promise<FinanceActionResult<unknown>>;
  /** Rendered instead of the form when the action cannot apply (already closed, not ready). */
  disabledNote?: string | null;
}

export function ConfirmAction({
  expected, expectedLabel, consequence, actionLabel,
  requireReason, reasonHint, run, disabledNote,
}: ConfirmActionProps) {
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (disabledNote) return <p className="fin-muted">{disabledNote}</p>;
  if (done) return <p className="fin-muted">{done}</p>;

  // Armed only on an EXACT match, matching the server's own comparison. A looser check here would
  // let the button enable and then be refused by the API, which reads as a broken button.
  const armed = typed === expected && (!requireReason || reason.trim().length > 0);

  return (
    <form
      className="fin-form"
      action={() => {
        setError(null);
        start(async () => {
          const r = await run({ confirm: typed, reason: requireReason ? reason.trim() : undefined });
          if (r.ok) setDone(`${actionLabel} — done.`);
          else setError(r.error ?? "Failed.");
        });
      }}
    >
      <p className="fin-muted fin-form__field--wide">{consequence}</p>

      <div className="fin-form__field">
        <label htmlFor={`confirm-${expected}`}>
          Type the {expectedLabel} to confirm
        </label>
        <input
          id={`confirm-${expected}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expected}
          autoComplete="off"
          aria-describedby={`confirm-help-${expected}`}
        />
        <span id={`confirm-help-${expected}`}>
          Exactly <strong>{expected}</strong>, including capitalisation.
        </span>
      </div>

      {requireReason ? (
        <div className="fin-form__field fin-form__field--wide">
          <label htmlFor={`reason-${expected}`}>Reason</label>
          <input
            id={`reason-${expected}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonHint ?? "Why now?"}
          />
          <span>Recorded permanently. The person who has to explain this later is rarely the person doing it.</span>
        </div>
      ) : null}

      {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}

      <div className="fin-form__actions">
        <Button type="submit" disabled={!armed || pending}>
          {pending ? "Working…" : actionLabel}
        </Button>
      </div>
    </form>
  );
}
