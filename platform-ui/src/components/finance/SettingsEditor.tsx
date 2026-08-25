"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { updateFinanceSettings } from "@/lib/financeActions";

/**
 * The two settings that are genuinely editable: PKP status and the NPWP.
 *
 * Everything else on this page is read-only and says why — see the page's header. This component
 * offers only what the database will actually accept, which is the point: a field that exists and
 * then fails is worse than one that was never offered.
 *
 * The NPWP is NOT validated here beyond "looks like digits". The 15-or-16 rule lives in the
 * database and its refusal carries a message worth reading; duplicating the rule would give the
 * user two sources of truth about their own tax number.
 */
export function SettingsEditor({ isPkp, npwp }: { isPkp: boolean; npwp: string }) {
  const [pkp, setPkp] = useState(isPkp);
  const [tax, setTax] = useState(npwp);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const r = await updateFinanceSettings({ isPkp: pkp, npwp: tax.trim() });
      if (r.ok) setSaved(true);
      else {
        setError(r.error ?? "Could not save these settings.");
        // Put the toggle back where the server says it is. Leaving it on the rejected value would
        // show a PKP status the books do not have.
        setPkp(isPkp);
      }
    });
  }

  return (
    <Card title="Edit">
      <div className="fin-form">
        <label className="fin-form__field">
          <span>PKP</span>
          <select value={pkp ? "yes" : "no"} onChange={(e) => setPkp(e.target.value === "yes")}>
            <option value="yes">Registered (charges PPN)</option>
            <option value="no">Not registered</option>
          </select>
        </label>

        <label className="fin-form__field">
          <span>NPWP</span>
          <input
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            placeholder="15 or 16 digits"
            inputMode="numeric"
          />
        </label>
      </div>

      <div className="fin-form__actions">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>

      {error && (
        <p className="fin-form__error" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="fin-muted">Saved.</p>}
    </Card>
  );
}
