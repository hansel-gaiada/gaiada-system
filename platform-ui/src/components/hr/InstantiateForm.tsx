"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HrResult } from "@/lib/hrActions";

// Manually trigger the onboarding/offboarding checklist spawn for a person —
// the same helper the automatic `user.invited` event handler calls (contract
// §10). hr.manage only (gated one level up by the caller not rendering this
// when the viewer lacks it).
export function InstantiateForm({ instantiate, tenantId, subjectOptions }: {
  instantiate: (tenantId: string, subjectUserId: string, kind: "onboarding" | "offboarding") => Promise<HrResult>;
  tenantId: string;
  subjectOptions: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    const subjectUserId = String(formData.get("subjectUserId") ?? "");
    const kind = String(formData.get("kind") ?? "onboarding") as "onboarding" | "offboarding";
    if (!subjectUserId) { setMsg("Choose a person first."); return; }
    startTransition(async () => {
      const res = await instantiate(tenantId, subjectUserId, kind);
      if (res.ok) { setMsg(null); router.refresh(); } else setMsg(res.error ?? "Couldn't start the checklist.");
    });
  }

  return (
    <form action={onSubmit} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <select name="subjectUserId" className="lux-field__control" style={{ width: "auto", minWidth: 180 }} defaultValue="" required>
        <option value="" disabled>Choose a person…</option>
        {subjectOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <select name="kind" className="lux-field__control" style={{ width: "auto" }} defaultValue="onboarding">
        <option value="onboarding">Onboarding</option>
        <option value="offboarding">Offboarding</option>
      </select>
      <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
        {pending ? "Starting…" : "Start checklist"}
      </button>
      {msg && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</span>}
    </form>
  );
}
