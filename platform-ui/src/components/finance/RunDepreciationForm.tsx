"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { runDepreciation } from "@/lib/financeActions";

// Charge depreciation for a period.
//
// ── THIS POSTS TO THE LEDGER, AND THE COPY SAYS SO ─────────────────────────────────────────────
// Every other control on the fixed-assets page is a read. This one writes journal entries that
// cannot afterwards be edited — a correction is a reversal, and both stay in the book. A button that
// looked like the rest of the page would be the wrong shape for that, so it names the consequence
// rather than saying "Run".
//
// ── NO CONFIRM DIALOG, DELIBERATELY ────────────────────────────────────────────────────────────
// Same reasoning as ReverseJournalForm: an "are you sure?" on a repeatable, idempotent action trains
// people to dismiss dialogs, and the real guarantee is downstream. A period already charged is
// refused by a UNIQUE INDEX in the database, so pressing this twice — or two people pressing it at
// once — cannot double-charge. A dialog would imply the safety lives here; it does not.
export function RunDepreciationForm({ periods }: { periods: Array<{ id: string; name: string }> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");

  if (periods.length === 0) {
    return (
      <p className="fin-muted" style={{ marginBlockStart: 16 }}>
        Every open period has already been charged. A closed period cannot be charged at all — the
        ledger refuses a posting into it, which is what closing a period means.
      </p>
    );
  }

  return (
    <form
      className="fin-form"
      style={{ marginBlockStart: 16 }}
      action={(fd) => {
        setError(null); setDone(null);
        start(async () => {
          const r = await runDepreciation(String(fd.get("periodId")));
          if (r.ok) setDone("Depreciation charged and posted."); else setError(r.error ?? "Failed.");
        });
      }}
    >
      <div className="fin-form__field">
        <label htmlFor="dep-period">Charge an open period</label>
        <select id="dep-period" name="periodId" value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
          {periods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span>Only periods with no charge yet are listed.</span>
      </div>

      {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
      {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

      <div className="fin-form__actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Charging…" : "Charge depreciation (posts to the ledger)"}
        </Button>
      </div>
    </form>
  );
}
