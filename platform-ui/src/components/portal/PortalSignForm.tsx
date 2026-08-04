"use client";
import { useActionState } from "react";
import { portalSignContract, type PortalActionResult } from "@/lib/portalActions";

// CP-14 — the client's countersignature on an agreement.
//
// ── WHAT MAKES THIS A SIGNATURE RATHER THAN A FORM SUBMISSION ─────────────────────────────────────
// Three things, and all three are enforced server-side as well:
//   * The signer types their own name. Not a pre-filled field they tab past — a `defaultValue` here
//     would make the recorded name evidence of nothing.
//   * An explicit attestation checkbox. The server refuses without `agree: true`, so the stored
//     signature can never be one the signer did not affirm.
//   * The terms are on the page above this form. A "sign" button on a page that does not show what is
//     being signed is not a signature at all.
// The backend additionally records a salted hash of the IP and the user-agent as weak corroboration.
//
// `useActionState` (not a void form action) because the server refuses for reasons the client must see:
// their access is view-only, the agreement has already been signed, its term has ended.
export function PortalSignForm({ contractId, title }: { contractId: string; title: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalSignContract,
    null,
  );

  if (state?.ok) {
    return (
      <div className="cp-form__ok" role="status">
        Signed — thank you. Your signature is recorded against {title}, and a copy of the agreement stays
        available on this page.
      </div>
    );
  }

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="contractId" value={contractId} />
      {state?.error && <div className="cp-form__error" role="alert">{state.error}</div>}

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="sign-name">Your full name</label>
        <input
          id="sign-name"
          className="cp-input"
          name="signerName"
          type="text"
          required
          minLength={2}
          maxLength={200}
          autoComplete="name"
          disabled={pending}
          aria-describedby="sign-name-hint"
        />
        <span className="cp-field__hint" id="sign-name-hint">
          Typing your name here has the same effect as signing by hand.
        </span>
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="sign-title">Your job title (optional)</label>
        <input id="sign-title" className="cp-input" name="signerTitle" type="text" maxLength={200}
               autoComplete="organization-title" disabled={pending} />
      </div>

      <label className="cp-check">
        <input type="checkbox" name="agree" value="yes" required disabled={pending} />
        <span>
          I have read the agreement above and I agree to its terms on behalf of my organisation.
        </span>
      </label>

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Signing…" : "Sign this agreement"}
        </button>
      </div>
    </form>
  );
}
