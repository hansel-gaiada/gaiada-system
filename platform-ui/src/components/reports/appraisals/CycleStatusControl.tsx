"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import type { patchAppraisalCycle } from "@/lib/appraisalActions";

type PatchFn = typeof patchAppraisalCycle;

const NEXT: Record<string, { status: "draft" | "open" | "in_review" | "closed"; label: string } | undefined> = {
  draft: { status: "open", label: "Open cycle" },
  open: { status: "in_review", label: "Move to review" },
  in_review: { status: "closed", label: "Close cycle" },
  closed: undefined,
};

// TR-26 — HR's open/close control (§ deliverable 1 "cycle CRUD, weights/role-weights config,
// open/close"). A cycle's own status is a simple forward-only workflow (draft -> open -> in_review
// -> closed); this never offers a backward transition, matching the cycle-admin-only PATCH surface.
export function CycleStatusControl({ cycleId, status, patchAction }: { cycleId: string; status: string; patchAction: PatchFn }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const next = NEXT[status];

  function onAdvance() {
    if (!next) return;
    setError(null);
    startTransition(async () => {
      const res = await patchAction(cycleId, { status: next.status });
      if (!res.ok) { setError(res.error ?? "Couldn't update the cycle."); return; }
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <StatusBadge label={status} />
      {next && (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onAdvance} disabled={pending}>
          {pending ? "Updating…" : next.label}
        </button>
      )}
      {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{error}</span>}
    </div>
  );
}
