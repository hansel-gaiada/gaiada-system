"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { createConsolidationRun, generateEliminations } from "@/lib/financeActions";

// The consolidation write side: start a run, then generate its eliminations.
//
// ── NOTHING HERE IS CONFIRMATION-GATED ─────────────────────────────────────────────────────────
// Unlike closing a period or committing a cutover, neither act here is terminal. A run is a dated
// working paper — creating a duplicate costs nothing — and eliminations can be regenerated as many
// times as the member companies' books change before the pack is finalised. The typed-confirmation
// gate exists for acts that cannot be undone by an ordinary correction; this is not one of them.

const today = () => new Date().toISOString().slice(0, 10);

export function CreateConsolidationRunForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <Card
      title="Start a new run"
      hint="A run is a dated working paper: the members summed, then the eliminations applied. Creating one is cheap — the eliminations below are what make it a consolidation."
    >
      <form
        className="fin-form"
        action={(fd) => {
          setError(null); setDone(null);
          start(async () => {
            const r = await createConsolidationRun({
              asOf: String(fd.get("asOf")),
              label: String(fd.get("label") || "") || undefined,
            });
            if (r.ok) {
              setDone(
                "Run created. Open it from the runs list above once it appears, then generate its "
                + "eliminations before reading its consolidated trial balance.",
              );
            } else setError(r.error ?? "Failed.");
          });
        }}
      >
        <div className="fin-form__field">
          <label htmlFor="consol-asOf">As of</label>
          <input id="consol-asOf" name="asOf" type="date" defaultValue={today()} required />
        </div>
        <div className="fin-form__field">
          <label htmlFor="consol-label">Label</label>
          <input id="consol-label" name="label" placeholder="August group pack" />
        </div>

        {error ? <p className="fin-form__error fin-form__field--wide">{error}</p> : null}
        {done ? <p className="fin-muted fin-form__field--wide">{done}</p> : null}

        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create run"}</Button>
        </div>
      </form>
    </Card>
  );
}

export function GenerateEliminationsAction({ runId, entryCount }: { runId: string; entryCount: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <Card title="Eliminations" hint="Runs BOTH the balance-sheet and the P&L elimination — see the page's own note on why doing only the first still double-counts intercompany revenue." style={{ marginTop: 22 }}>
      <p className="fin-muted">
        {entryCount > 0
          ? `${entryCount} elimination entr${entryCount === 1 ? "y" : "ies"} recorded for this run already. Running again regenerates both the balance-sheet and P&L eliminations.`
          : "No elimination entries yet — the consolidated trial balance below is refused until there are some."}
      </p>
      <div className="fin-form__actions" style={{ marginTop: 12 }}>
        <Button
          disabled={pending}
          onClick={() => {
            setError(null); setDone(null);
            start(async () => {
              const r = await generateEliminations(runId);
              if (r.ok) setDone(`Done — ${r.result?.entryCount ?? 0} elimination entries.`);
              else setError(r.error ?? "Failed.");
            });
          }}
        >
          {pending ? "Generating…" : "Generate eliminations"}
        </Button>
      </div>
      {error ? <p className="fin-form__error" style={{ marginTop: 8 }}>{error}</p> : null}
      {done ? <p className="fin-muted" style={{ marginTop: 8 }}>{done}</p> : null}
    </Card>
  );
}
