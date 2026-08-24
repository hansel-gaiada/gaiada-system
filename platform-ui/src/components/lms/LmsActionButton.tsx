"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LmsResult } from "@/lib/lmsActions";

/**
 * A one-field server action behind a button — publish, retire, delete an activity.
 *
 * `confirm` is required for anything that changes what learners can see. Publishing freezes the
 * material somebody will be CERTIFIED against, and retiring withdraws material people may be
 * mid-way through; neither should be one stray click away.
 *
 * The result message is rendered INLINE rather than thrown away, because the most important thing
 * the LMS backend ever says comes back through here: "that course was published, so your edit
 * opened a new version". An author who does not see that sentence believes they fixed the live
 * course and did not.
 */
export function LmsActionButton({
  action, fields, label, pendingLabel, confirm, tone = "ghost",
}: {
  action: (formData: FormData) => Promise<LmsResult>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  tone?: "solid" | "ghost";
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () => {
    if (confirm && !window.confirm(confirm)) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    startTransition(async () => {
      const res = await action(fd);
      setBad(!res.ok);
      setMsg(res.ok ? res.note ?? null : res.error ?? "That didn't work.");
      if (res.ok) router.refresh();
    });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button type="button" className={`lux-btn lux-btn--${tone} lux-btn--sm`} onClick={run} disabled={pending}>
        {pending ? pendingLabel ?? "Working…" : label}
      </button>
      {msg && (
        <span
          role={bad ? "alert" : "status"}
          style={{
            font: "400 12px/1.5 var(--font-body)", maxWidth: 460,
            color: bad ? "var(--status-danger-fg)" : "var(--erp-ink-60)",
          }}
        >
          {msg}
        </span>
      )}
    </span>
  );
}
