"use client";
import { useActionState, useEffect, useState } from "react";
import { recompute, type RecomputeState } from "@/app/(app)/rollups/actions";
import { Button, Toast } from "@/components/ui";

export function RecomputeButton({ tenantId }: { tenantId: string }) {
  const boundRecompute = recompute.bind(null, tenantId);
  const [state, formAction, pending] = useActionState<RecomputeState | null, FormData>(boundRecompute, null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!state) return;
    setToast(state.ok ? "Recompute started — figures will refresh shortly." : state.error ?? "That recompute didn't go through — please try again.");
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <form action={formAction}>
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Recomputing…" : "Recompute"}
      </Button>
      {toast && <Toast message={toast} />}
    </form>
  );
}
