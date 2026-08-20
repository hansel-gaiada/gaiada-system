"use client";
import { useActionState } from "react";
import { portalDecideSocialReview } from "@/lib/portalActions";
import type { PortalActionResult } from "@/lib/portalActions";

// SMM-31/32 — the client's own approve / request-changes decision on a drafted social post.
//
// `useActionState` (not `PortalGateActions`'s void form-action shape) because the server refuses for
// reasons the client must see (a stale replay, a genuine race) — same reasoning `PortalSignForm`
// gives for the identical choice on a contract signature.
//
// ── WHY THIS COMPONENT NEVER OFFERS A SECOND DECISION ─────────────────────────────────────────────
// The PARENT page only renders this form at all while `review.status === 'pending'` (a fresh
// server read on every load) — a decided review's detail page never mounts this component in the
// first place, so there is no "undo" or "change my mind" control anywhere in this UI to guard
// against. Once `state.ok` is true (this decision just landed), the component swaps itself for a
// static confirmation and never re-shows the buttons for the rest of this render — the identical
// local-state guarantee `PortalSignForm` already relies on for a signature.
export function PortalSocialReviewDecideForm({ reviewId }: { reviewId: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalDecideSocialReview,
    null,
  );

  if (state?.ok) {
    return (
      <div className="cp-form__ok" role="status">
        Thanks — your decision is recorded. Refresh this page to see the current status.
      </div>
    );
  }

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="reviewId" value={reviewId} />
      {state?.error && <div className="cp-form__error" role="alert">{state.error}</div>}

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="review-comment">Comment (optional)</label>
        <textarea
          id="review-comment"
          className="cp-input"
          name="comment"
          rows={3}
          maxLength={4000}
          disabled={pending}
          placeholder="Tell us what to change, or leave a note with your approval."
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" name="decision" value="approved" className="btn btn-primary" disabled={pending}>
          {pending ? "Submitting…" : "Looks good"}
        </button>
        <button type="submit" name="decision" value="changes_requested" className="btn" disabled={pending}>
          {pending ? "Submitting…" : "Request changes"}
        </button>
      </div>
    </form>
  );
}
