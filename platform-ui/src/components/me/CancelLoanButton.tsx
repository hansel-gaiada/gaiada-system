"use client";
// Withdraw one's OWN pending loan request. Mirrors components/hr/CancelLeaveButton.tsx, including the
// confirm step: withdrawing also cancels the paired approval sitting in a decider's inbox, so it is
// not a click to make by accident.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelLoan } from "@/lib/loanActions";

export function CancelLoanButton({ tenantId, loanId }: { tenantId: string; loanId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onCancel = () => {
    startTransition(async () => {
      const res = await cancelLoan(tenantId, loanId);
      if (res.ok) {
        setConfirming(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't withdraw the request.");
      }
    });
  };

  if (msg) {
    return <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</span>;
  }

  if (!confirming) {
    return (
      <button type="button" className="lux-btn lux-btn--sm" onClick={() => setConfirming(true)}>
        Withdraw
      </button>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>Withdraw this request?</span>
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onCancel} disabled={pending}>
        {pending ? "Withdrawing…" : "Yes, withdraw"}
      </button>
      <button type="button" className="lux-btn lux-btn--sm" onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </span>
  );
}
