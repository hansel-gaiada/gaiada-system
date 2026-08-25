"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { postJournalEntry } from "@/lib/financeActions";
import type { Account } from "@/lib/finance";

// The journal entry screen.
//
// ── THE RUNNING TOTALS ARE AN AID, NOT A GATE ──────────────────────────────────────────────────
// The debit and credit totals update as you type and the difference is shown. That is a courtesy so
// an accountant can see the entry balance before submitting — it is NOT validation. The database
// decides whether an entry is balanced, and the form does not block submission on its own
// arithmetic.
//
// The distinction matters. If the form refused to submit whenever ITS sum disagreed, then any
// rounding difference between JS floating point and Postgres numeric would make a perfectly valid
// entry unsubmittable, with no way past it. Showing the difference helps; enforcing it here would
// eventually lock someone out of their own books over a half-cent.
//
// ── WHY THERE IS NO "SAVE DRAFT" ───────────────────────────────────────────────────────────────
// A posted journal is immutable and a draft is not a journal. Offering both on one screen invites
// the assumption that posting is reversible because saving was. It is not: correction is by
// reversal, and the reversal is visible forever.

interface Line {
  accountCode: string;
  side: "debit" | "credit";
  amount: string;
  memo: string;
}

const BLANK: Line = { accountCode: "", side: "debit", amount: "", memo: "" };

export function JournalEntryForm({ accounts }: { accounts: Account[] }) {
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }, { ...BLANK, side: "credit" }]);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const num = (s: string) => {
    const n = Number(s.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const totalDebit = lines.filter((l) => l.side === "debit").reduce((a, l) => a + num(l.amount), 0);
  const totalCredit = lines.filter((l) => l.side === "credit").reduce((a, l) => a + num(l.amount), 0);
  const difference = totalDebit - totalCredit;

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  function submit() {
    setError(null);
    setPosted(null);
    const filled = lines.filter((l) => l.accountCode.trim() && l.amount.trim());
    if (filled.length === 0) {
      setError("Add at least one line with an account and an amount.");
      return;
    }
    if (!date.trim()) {
      setError("A date is required — it decides which period this entry belongs to.");
      return;
    }
    if (!description.trim()) {
      setError("A description is required. It is what somebody reads in the ledger a year from now.");
      return;
    }
    start(async () => {
      const r = await postJournalEntry({
        date: date.trim(),
        // Every journal must be traceable to an event. A manual entry's event is the person and the
        // moment, so the reference defaults to something unique rather than blank — the database
        // rejects a missing one, and "manual" alone would collide on the second entry.
        sourceEventId: reference.trim() || `manual:${date.trim()}:${Date.now()}`,
        description: description.trim(),
        lines: filled.map((l) => ({
          accountCode: l.accountCode.trim(),
          side: l.side,
          amount: l.amount.trim(),
          memo: l.memo.trim() || undefined,
        })),
      });
      if (r.ok) {
        setPosted(r.result?.id ?? "posted");
        setLines([{ ...BLANK }, { ...BLANK, side: "credit" }]);
        setDescription("");
        setReference("");
      } else {
        setError(r.error ?? "Could not post this entry.");
      }
    });
  }

  return (
    <Card
      title="Post a journal entry"
      hint="A posted entry is permanent. A mistake is corrected by a reversal, which stays visible beside it — there is no edit and no delete."
    >
      <div className="fin-form">
        <label className="fin-form__field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="fin-form__field fin-form__field--wide">
          <span>Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this entry records"
          />
        </label>
        <label className="fin-form__field">
          <span>Reference</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <table className="fin-lines">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Side</th>
            <th scope="col" className="fin-lines__num">Amount</th>
            <th scope="col">Memo</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })}>
                  <option value="">Select an account…</option>
                  {accounts
                    // Only postable accounts. A heading like "1000 ASET" exists to group the chart,
                    // not to receive money, and the database refuses it — offering it here would
                    // mean discovering that only after filling the whole entry in.
                    .filter((a) => a.isPostable)
                    .map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} — {a.name}
                        {a.isControl ? " (subledger control)" : ""}
                      </option>
                    ))}
                </select>
              </td>
              <td>
                <select value={l.side} onChange={(e) => setLine(i, { side: e.target.value as "debit" | "credit" })}>
                  <option value="debit">Debit</option>
                  <option value="credit">Credit</option>
                </select>
              </td>
              <td className="fin-lines__num">
                <input value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} inputMode="decimal" />
              </td>
              <td>
                <input value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} placeholder="optional" />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>Totals</th>
            <td className="fin-lines__num">
              {totalDebit.toLocaleString("en-GB")} / {totalCredit.toLocaleString("en-GB")}
            </td>
            <td>
              {/* An aid, not a gate — see the header. */}
              {difference === 0 ? (
                <span className="fin-muted">balanced</span>
              ) : (
                <span className="fin-form__error">out by {Math.abs(difference).toLocaleString("en-GB")}</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="fin-form__actions">
        <Button onClick={() => setLines((ls) => [...ls, { ...BLANK }])} disabled={pending}>
          Add line
        </Button>
        <Button onClick={submit} disabled={pending}>
          {pending ? "Posting…" : "Post entry"}
        </Button>
      </div>

      {error && (
        <p className="fin-form__error" role="alert">
          {error}
        </p>
      )}
      {posted && <p className="fin-muted">Posted. It is now part of the ledger and cannot be edited.</p>}
    </Card>
  );
}
