"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Button } from "@/components/ui";
import { reverseJournalEntry } from "@/lib/financeActions";

/**
 * Reverse a posted entry.
 *
 * ── THE REASON IS REQUIRED, AND THAT IS THE POINT ──────────────────────────────────────────────
 * The database refuses a reversal without one (FINANCE_REVERSAL_REASON_REQUIRED). It is not
 * bureaucratic: a reversal is the only way a figure in this ledger changes, so it is the one place
 * where "why" has to be captured at the moment it is known. Six months later the entry and its
 * reversal both still exist, and the reason is the only thing that explains the pair.
 *
 * ── NO CONFIRMATION DIALOG ─────────────────────────────────────────────────────────────────────
 * Deliberately absent. A reversal is not destructive — nothing is lost, a second entry is added —
 * so a "are you sure?" would train people to click through confirmations on a surface where a
 * genuinely irreversible action (closing a period) also lives. The friction that belongs here is
 * having to write the reason, which is friction that produces something useful.
 */
export function ReverseJournalForm({ entryId }: { entryId: string }) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit() {
    setError(null);
    if (!reason.trim()) {
      setError("A reason is required — it is the only thing that will explain this pair of entries later.");
      return;
    }
    start(async () => {
      const r = await reverseJournalEntry(entryId, reason.trim(), date.trim() || undefined);
      if (r.ok) {
        // Straight to the new entry: the reversal is itself a journal, and landing on it makes what
        // just happened concrete rather than leaving the reader on a page that now says "reversed".
        router.push(r.result?.id ? `/finance/journals/${r.result.id}` : "/finance/journals");
      } else {
        setError(r.error ?? "Could not reverse this entry.");
      }
    });
  }

  return (
    <Card
      title="Reverse this entry"
      hint="A reversal adds an equal and opposite entry. Nothing is deleted and both remain in the register."
    >
      <div className="fin-form">
        <label className="fin-form__field fin-form__field--wide">
          <span>Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this entry is being reversed"
          />
        </label>
        <label className="fin-form__field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {/* Blank means today. A reversal cannot be dated into a closed period — the database
              refuses it — which is why the field exists at all rather than always using today. */}
        </label>
      </div>
      <div className="fin-form__actions">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Reversing…" : "Reverse entry"}
        </Button>
      </div>
      {error && (
        <p className="fin-form__error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
