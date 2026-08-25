"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { createOwnershipEdge } from "@/lib/financeActions";

// The cap-table write form.
//
// ── IT VALIDATES SHAPE AND NOTHING ELSE ────────────────────────────────────────────────────────
// "Exactly one holder" and "a date is required" are checked here because they decide whether a
// request is even well-formed. Everything else — whether the stakes now exceed 100%, whether the
// holder exists, whether the caller may write at all — is the server's, and its answers are
// rendered verbatim.
//
// That split is deliberate. A form that re-implements a server rule drifts from it, and the copy
// that drifts is the one the user sees: they get "looks fine" here and a refusal from the server,
// or worse, the reverse.
//
// ── THE 100% RULE IS NOT ENFORCED HERE, ON PURPOSE ─────────────────────────────────────────────
// A cap table is entered one row at a time and passes through invalid totals on the way to a
// correct one. Blocking the row that takes the total over 100 would make a four-holder table
// impossible to type. The page shows the problem; the consolidation refuses to rely on it.
export function OwnershipEditor() {
  const [holderKind, setHolderKind] = useState<"person" | "company">("person");
  const [holderId, setHolderId] = useState("");
  const [kind, setKind] = useState<"holding" | "shareholder">("shareholder");
  const [stake, setStake] = useState("");
  const [from, setFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function submit() {
    setError(null);
    setDone(false);
    if (!holderId.trim()) {
      setError("A holder is required — paste the person's or company's id.");
      return;
    }
    if (!from.trim()) {
      setError("An effective-from date is required. Ownership is dated, so “when” is part of the fact.");
      return;
    }
    start(async () => {
      const r = await createOwnershipEdge({
        holderUserId: holderKind === "person" ? holderId.trim() : null,
        holderCompanyId: holderKind === "company" ? holderId.trim() : null,
        kind,
        // Empty means UNKNOWN, which the database stores as NULL. Not zero — a fabricated 0 would
        // read as "holds nothing" rather than "we do not know".
        stakePct: stake.trim() === "" ? null : stake.trim(),
        effectiveFrom: from.trim(),
        notes: notes.trim() || undefined,
      });
      if (r.ok) {
        setDone(true);
        setHolderId("");
        setStake("");
        setNotes("");
      } else {
        setError(r.error ?? "Could not record this ownership edge.");
      }
    });
  }

  return (
    <Card
      title="Record a holder"
      hint="A holding edge also confers sight of every company beneath this one — it is an access decision, not only a financial one."
    >
      <div className="fin-form">
        <label className="fin-form__field">
          <span>Holder is</span>
          <select value={holderKind} onChange={(e) => setHolderKind(e.target.value as "person" | "company")}>
            <option value="person">A person</option>
            <option value="company">A company</option>
          </select>
        </label>

        <label className="fin-form__field">
          <span>{holderKind === "person" ? "User id" : "Company id"}</span>
          <input value={holderId} onChange={(e) => setHolderId(e.target.value)} placeholder="uuid" />
        </label>

        <label className="fin-form__field">
          <span>Edge</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "holding" | "shareholder")}>
            <option value="shareholder">Shareholder — a stake in this company only</option>
            <option value="holding">Holding — this company and everything beneath it</option>
          </select>
        </label>

        <label className="fin-form__field">
          <span>Stake %</span>
          <input
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder="leave blank if unknown"
            inputMode="decimal"
          />
        </label>

        <label className="fin-form__field">
          <span>Effective from</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <label className="fin-form__field fin-form__field--wide">
          <span>Note</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <div className="fin-form__actions">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Recording…" : "Record holder"}
        </Button>
      </div>

      {/* Verbatim from the server. The database writes messages worth reading and replacing them
          with "Could not save" throws away the half that says what to do. */}
      {error && (
        <p className="fin-form__error" role="alert">
          {error}
        </p>
      )}
      {done && <p className="fin-muted">Recorded. The cap table above refreshes on reload.</p>}
    </Card>
  );
}
