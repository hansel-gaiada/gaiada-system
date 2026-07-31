"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ackAppraisal } from "@/lib/appraisalActions";
import "@/components/forms/forms.css";
import "./appraisals.css";

type AckFn = typeof ackAppraisal;

// TR-26 — the subject's move (§6.2 `POST /appraisals/:id/ack`). Rendered as `AppraisalPackView`'s
// `footerSlot` on the subject's read of their own pack — everything ABOVE this form is the exact
// same markup the manager saw (the fairness guarantee lives in AppraisalPackView itself, not here).
// Once acknowledged or disputed, this form disappears in favour of a plain status line — the ack
// trail itself (rendered inside AppraisalPackView's History section) is the only record from then
// on, and it is genuinely append-only: there is no edit/re-ack affordance here for a status that
// already has an entry, because the database trigger would reject it anyway.
export function AckDisputeForm({ appraisalId, ackAction }: { appraisalId: string; ackAction: AckFn }) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onAck(action: "acknowledged" | "disputed") {
    setError(null);
    startTransition(async () => {
      const res = await ackAction(appraisalId, action, comment.trim() || undefined);
      if (!res.ok) { setError(res.error ?? "That didn't go through — try again."); return; }
      router.refresh();
    });
  }

  return (
    <section className="rc-section">
      <h3 className="rc-section__title">Your response</h3>
      <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--rc-text-secondary)" }}>
        You can acknowledge this appraisal, or dispute it if something reads as wrong or unfair — a dispute
        routes to HR and is never held against you for raising it.
      </p>
      <label className="lux-field">
        <textarea
          className="lux-field__control lux-field__control--textarea"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Optional comment — required detail for a dispute is helpful but not enforced here."
        />
      </label>
      {error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--rc-critical)" }}>{error}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="rc-appr-btn rc-appr-btn--solid" onClick={() => onAck("acknowledged")} disabled={pending}>
          {pending ? "Sending…" : "Acknowledge"}
        </button>
        <button type="button" className="rc-appr-btn rc-appr-btn--ghost" onClick={() => onAck("disputed")} disabled={pending}>
          {pending ? "Sending…" : "Dispute"}
        </button>
      </div>
    </section>
  );
}
