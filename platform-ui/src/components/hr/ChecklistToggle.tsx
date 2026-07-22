"use client";
import { useState, useTransition } from "react";
import type { ChecklistItem } from "@/lib/hr";
import type { HrResult } from "@/lib/hrActions";

type Update = (tenantId: string, caseId: string, items: { label: string; done: boolean }[]) => Promise<HrResult>;

// Optimistic checklist toggle used on both the onboarding board and the case
// detail page. Reverts on a failed write and surfaces the error inline rather
// than losing the click.
export function ChecklistToggle({ tenantId, caseId, items, update, readOnly }: {
  tenantId: string; caseId: string; items: ChecklistItem[]; update: Update; readOnly?: boolean;
}) {
  const [local, setLocal] = useState(items);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function toggle(idx: number) {
    if (readOnly) return;
    const prev = local;
    const next = local.map((it, i) => (i === idx ? { ...it, done: !it.done } : it));
    setLocal(next);
    startTransition(async () => {
      const res = await update(tenantId, caseId, next.map(({ label, done }) => ({ label, done })));
      if (!res.ok) {
        setLocal(prev);
        setErr(res.error ?? "Couldn't save that change.");
        setTimeout(() => setErr(null), 2500);
      }
    });
  }

  const done = local.filter((i) => i.done).length;
  return (
    <div>
      <div style={{ marginBottom: 10, font: "700 12px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-50)" }}>
        {done} of {local.length} complete
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {local.map((it, i) => (
          <li key={`${it.label}-${i}`}>
            <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: readOnly ? "default" : "pointer", opacity: pending ? 0.7 : 1 }}>
              <input type="checkbox" checked={it.done} disabled={readOnly} onChange={() => toggle(i)} />
              <span style={{ font: "400 14px var(--font-body)", textDecoration: it.done ? "line-through" : "none", color: it.done ? "var(--erp-ink-50)" : "var(--text-primary)" }}>
                {it.label}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {err && <p style={{ color: "var(--erp-accent)", font: "400 12px var(--font-body)", marginTop: 8 }}>{err}</p>}
    </div>
  );
}
