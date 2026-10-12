"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  abortExperimentAction, decideExperimentAction, stopExperimentAction, syncExperimentAction, type ActionResult,
} from "@/lib/experimentsActions";
import { actionsFor, type Status } from "@/lib/experimentsModel";

// The four actions, each shown only when the status allows it AND the user can update. The server still decides;
// a refusal comes back as a sentence and is shown as is.
export function ExperimentActions({ propertyId, experimentId, status, canUpdate }: { propertyId: string; experimentId: string; status: Status; canUpdate: boolean }) {
  const router = useRouter();
  const a = actionsFor(status, canUpdate);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [note, setNote] = useState("");
  if (!a.sync && !a.stop && !a.abort && !a.decide) return null;

  const run = async (name: string, fn: () => Promise<ActionResult>) => {
    if (busy) return;
    setBusy(name); setMsg(null);
    const r = await fn();
    setBusy(null); setMsg(r);
    if (r.ok) router.refresh();
  };
  const b = (name: string, label: string, fn: () => Promise<ActionResult>, ghost = true) => (
    <button type="button" className={`lux-btn ${ghost ? "lux-btn--ghost" : "lux-btn--solid"} lux-btn--sm`} disabled={busy !== null} onClick={() => run(name, fn)} data-testid={`exp-${name}`}>
      {busy === name ? `${label}...` : label}
    </button>
  );

  return (
    <div className="wa-note" data-testid="exp-actions">
      <div>
        {a.sync ? b("sync", "Check if it is live", () => syncExperimentAction(propertyId, experimentId)) : null}{" "}
        {a.stop ? b("stop", "Stop the test", () => stopExperimentAction(propertyId, experimentId)) : null}{" "}
        {a.abort ? b("abort", "Abort the test", () => abortExperimentAction(propertyId, experimentId)) : null}
      </div>
      {a.decide ? (
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="exp-note">Note for the decision (optional)</label>
          <textarea id="exp-note" className="lux-field__control" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          {b("decide", "Record the decision", () => decideExperimentAction(propertyId, experimentId, note), false)}
        </div>
      ) : null}
      {msg ? <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "wa-note" : "wa-range__err"} data-testid="exp-action-msg">{msg.message}</p> : null}
    </div>
  );
}
