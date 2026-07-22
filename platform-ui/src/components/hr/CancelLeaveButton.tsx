"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HrResult } from "@/lib/hrActions";

// Cancel-own-pending-request button (leave and cases share the same shape —
// the backend enforces "own pending only", this is just the button).
export function CancelLeaveButton({ tenantId, id, cancel, label = "Cancel" }: {
  tenantId: string; id: string; cancel: (tenantId: string, id: string) => Promise<HrResult>; label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onClick() {
    startTransition(async () => {
      const res = await cancel(tenantId, id);
      if (res.ok) router.refresh();
      else { setErr(res.error ?? "Couldn't cancel."); setTimeout(() => setErr(null), 2200); }
    });
  }

  return (
    <>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClick} disabled={pending}>
        {pending ? "…" : label}
      </button>
      {err && <span style={{ marginLeft: 8, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{err}</span>}
    </>
  );
}
