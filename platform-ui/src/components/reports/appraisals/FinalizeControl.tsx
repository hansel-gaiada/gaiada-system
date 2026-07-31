"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { finalizeAppraisal, confirmAppraisalEvidence } from "@/lib/appraisalActions";
import "./appraisals.css";

type FinalizeFn = typeof finalizeAppraisal;
type ConfirmFn = typeof confirmAppraisalEvidence;

// TR-26 — HR's finalize control (§6.2 `POST /appraisals/:id/finalize`), the other `footerSlot` for
// `AppraisalPackView`. Ethical requirement 3: when `evidenceStale` is true, this NEVER renders a
// disabled/dead "Finalize" button with no explanation — it renders the re-confirm action instead,
// with the same reason text `AppraisalPackView`'s banner already gave above it.
export function FinalizeControl({ appraisalId, evidenceStale, status, finalizeAction, confirmEvidenceAction }: {
  appraisalId: string;
  evidenceStale: boolean;
  status: string;
  finalizeAction: FinalizeFn;
  confirmEvidenceAction: ConfirmFn;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (status === "finalized") return null;
  if (!["submitted", "acknowledged", "disputed"].includes(status)) return null;

  function onFinalize() {
    setError(null);
    startTransition(async () => {
      const res = await finalizeAction(appraisalId);
      if (!res.ok) { setError(res.error ?? "Couldn't finalize — try again."); return; }
      router.refresh();
    });
  }
  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const res = await confirmEvidenceAction(appraisalId);
      if (!res.ok) { setError(res.error ?? "Couldn't re-confirm — try again."); return; }
      router.refresh();
    });
  }

  return (
    <section className="rc-section">
      <h3 className="rc-section__title">HR</h3>
      {error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--rc-critical)" }}>{error}</p>}
      {evidenceStale ? (
        <>
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--rc-text-secondary)" }}>
            Finalize is blocked until the evidence above is re-confirmed.
          </p>
          <button type="button" className="rc-appr-btn rc-appr-btn--solid" onClick={onConfirm} disabled={pending}>
            {pending ? "Confirming…" : "Re-confirm evidence"}
          </button>
        </>
      ) : (
        <button type="button" className="rc-appr-btn rc-appr-btn--solid" onClick={onFinalize} disabled={pending}>
          {pending ? "Finalizing…" : "Finalize"}
        </button>
      )}
    </section>
  );
}
