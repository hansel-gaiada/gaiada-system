"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { AXIS_LABELS, APPRAISAL_AXES, type AppraisalAxis } from "@/lib/appraisals";
import type { createAppraisalCycle } from "@/lib/appraisalActions";
import "@/components/forms/forms.css";

type CreateFn = typeof createAppraisalCycle;

const DEFAULT_WEIGHTS: Record<AppraisalAxis, number> = { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 };

// TR-26 — HR's "New cycle" form. §5.2 point 5's "manager judgment is the score; auto is an input,
// effort has the lowest default weight (0.10)" is reflected here only as a SENSIBLE DEFAULT, never
// enforced — HR can set any weighting per cycle (and per role, via the cycle detail page's weights
// editor); this form doesn't second-guess that.
export function CycleForm({ createAction }: { createAction: CreateFn }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [weights, setWeights] = useState<Record<AppraisalAxis, number>>(DEFAULT_WEIGHTS);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const weightSum = APPRAISAL_AXES.reduce((s, a) => s + (weights[a] ?? 0), 0);

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const name = String(formData.get("name") ?? "").trim();
      const periodStart = String(formData.get("periodStart") ?? "");
      const periodEnd = String(formData.get("periodEnd") ?? "");
      const res = await createAction({ name, periodStart, periodEnd, defaultWeights: weights });
      if (!res.ok) { setError(res.error ?? "Couldn't create the cycle."); return; }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        New cycle
      </button>
    );
  }

  return (
    <Card title="New appraisal cycle" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <Field name="name" label="Name" placeholder="2026 H2 Performance Review" required />
        <Field name="periodStart" label="Period start" type="date" required />
        <Field name="periodEnd" label="Period end" type="date" required />
        <div style={{ gridColumn: "1 / -1" }}>
          <p style={{ margin: "0 0 8px", font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
            Default axis weights (sum {Math.round(weightSum * 100)}%)
          </p>
          <div className="rc-appr-weights">
            {APPRAISAL_AXES.map((axis) => (
              <label className="lux-field" key={axis}>
                <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{AXIS_LABELS[axis]}</span>
                <input
                  type="number" min={0} max={1} step={0.05} className="lux-field__control"
                  value={weights[axis]}
                  onChange={(e) => setWeights((prev) => ({ ...prev, [axis]: Number(e.target.value) }))}
                />
              </label>
            ))}
          </div>
        </div>
        {error && (
          <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{error}</p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Creating…" : "Create cycle"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setError(null); }} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
