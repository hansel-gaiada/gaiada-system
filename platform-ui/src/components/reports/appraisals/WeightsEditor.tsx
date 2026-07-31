"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AXIS_LABELS, APPRAISAL_AXES, type AppraisalAxis } from "@/lib/appraisals";
import type { patchAppraisalCycle } from "@/lib/appraisalActions";
import "@/components/forms/forms.css";

type PatchFn = typeof patchAppraisalCycle;

// TR-26 — the cycle detail page's "weights/role-weights config" deliverable. Default weights are
// always editable; a role-weight override is added one role key at a time (HR-authored free
// strings — appraisal-engine.ts's own header: "no canonical mapping to anything else in the
// schema", so this form doesn't pretend to validate the key against anything).
export function WeightsEditor({ cycleId, defaultWeights, roleWeights, patchAction }: {
  cycleId: string;
  defaultWeights: Record<AppraisalAxis, number>;
  roleWeights: Record<string, Record<AppraisalAxis, number>>;
  patchAction: PatchFn;
}) {
  const router = useRouter();
  const [weights, setWeights] = useState(defaultWeights);
  const [newRoleKey, setNewRoleKey] = useState("");
  const [newRoleWeights, setNewRoleWeights] = useState<Record<AppraisalAxis, number>>(defaultWeights);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSaveDefault() {
    setError(null);
    startTransition(async () => {
      const res = await patchAction(cycleId, { defaultWeights: weights });
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      router.refresh();
    });
  }

  function onAddRole() {
    if (!newRoleKey.trim()) { setError("Enter a role cohort key first."); return; }
    setError(null);
    startTransition(async () => {
      const res = await patchAction(cycleId, { roleWeights: { ...roleWeights, [newRoleKey.trim()]: newRoleWeights } });
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      setNewRoleKey("");
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <p style={{ margin: "0 0 8px", font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
          Default weights
        </p>
        <div className="rc-appr-weights">
          {APPRAISAL_AXES.map((axis) => (
            <label className="lux-field" key={axis}>
              <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{AXIS_LABELS[axis]}</span>
              <input type="number" min={0} max={1} step={0.05} className="lux-field__control" value={weights[axis]} onChange={(e) => setWeights((prev) => ({ ...prev, [axis]: Number(e.target.value) }))} />
            </label>
          ))}
        </div>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ marginTop: 8 }} onClick={onSaveDefault} disabled={pending}>
          {pending ? "Saving…" : "Save default weights"}
        </button>
      </div>

      {Object.keys(roleWeights).length > 0 && (
        <div>
          <p style={{ margin: "0 0 8px", font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
            Role overrides
          </p>
          {Object.entries(roleWeights).map(([role, w]) => (
            <p key={role} style={{ margin: "0 0 4px", font: "400 13px var(--font-body)" }}>
              <strong>{role}</strong>: {APPRAISAL_AXES.map((a) => `${AXIS_LABELS[a]} ${Math.round(w[a] * 100)}%`).join(" · ")}
            </p>
          ))}
        </div>
      )}

      <div>
        <p style={{ margin: "0 0 8px", font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
          Add a role override
        </p>
        <input
          type="text" className="lux-field__control" placeholder="role cohort key, e.g. senior_developer"
          value={newRoleKey} onChange={(e) => setNewRoleKey(e.target.value)} style={{ marginBottom: 8, maxWidth: 320 }}
        />
        <div className="rc-appr-weights">
          {APPRAISAL_AXES.map((axis) => (
            <label className="lux-field" key={axis}>
              <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{AXIS_LABELS[axis]}</span>
              <input type="number" min={0} max={1} step={0.05} className="lux-field__control" value={newRoleWeights[axis]} onChange={(e) => setNewRoleWeights((prev) => ({ ...prev, [axis]: Number(e.target.value) }))} />
            </label>
          ))}
        </div>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ marginTop: 8 }} onClick={onAddRole} disabled={pending}>
          {pending ? "Saving…" : "Add role override"}
        </button>
      </div>
      {error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{error}</p>}
    </div>
  );
}
