"use client";
import { useActionState } from "react";
import { portalRequestProfileChange, portalUpdateProfile, type PortalActionResult } from "@/lib/portalActions";

// CP-15 — the two things a client may change, and the shape of the boundary between them.
//
// `PortalOwnDetailsForm` writes directly: it edits the caller's OWN `users` row (name, title). That is
// their identity, not our record of the account.
//
// `PortalChangeRequestForm` writes NOTHING. Company name, billing address and tax details live on the
// `clients` row, which appears on invoices already issued and contracts already signed — a client editing
// it after the fact silently changes what those frozen documents appear to say. So the portal records the
// ASK (an activity + a notification to the account owners) and a human applies it. Slower on purpose, and
// the copy says so rather than implying an instant change.
export function PortalOwnDetailsForm({ name, title }: { name: string; title: string | null }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalUpdateProfile,
    null,
  );
  return (
    <form action={formAction} className="cp-form">
      {state?.error && <div className="cp-form__error" role="alert">{state.error}</div>}
      {state?.ok && <div className="cp-form__ok" role="status">Saved.</div>}

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="me-name">Your name</label>
        {/* `defaultValue` and an uncontrolled input: the field is pre-filled because this is an EDIT of
            existing details, unlike the signature field, which must be typed from scratch. */}
        <input id="me-name" className="cp-input" name="name" type="text" required minLength={2} maxLength={200}
               defaultValue={name} autoComplete="name" disabled={pending} />
      </div>

      <div className="cp-field">
        <label className="cp-field__label" htmlFor="me-title">Your job title</label>
        <input id="me-title" className="cp-input" name="title" type="text" maxLength={200}
               defaultValue={title ?? ""} autoComplete="organization-title" disabled={pending} />
      </div>

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <p style={{ margin: "8px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          {/* Stated because it is the obvious next question, and because the server genuinely refuses it:
              the email is the identity your sign-in and your invite are bound to. */}
          Your email address is how you sign in, so it can only be changed by your account manager.
        </p>
      </div>
    </form>
  );
}

export function PortalChangeRequestForm({ clientId }: { clientId: string }) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(
    portalRequestProfileChange,
    null,
  );

  if (state?.ok) {
    return (
      <div className="cp-form__ok" role="status">
        Thanks — we&apos;ve passed that to your account manager. They&apos;ll make the change and it will
        show up here.
      </div>
    );
  }

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="clientId" value={clientId} />
      {state?.error && <div className="cp-form__error" role="alert">{state.error}</div>}
      <div className="cp-field">
        <label className="cp-field__label" htmlFor="cr-message">What should we change?</label>
        <textarea
          id="cr-message"
          className="cp-textarea"
          name="message"
          required
          minLength={5}
          maxLength={2000}
          placeholder="e.g. our billing address is now Jl. Sudirman 5, or please add Marco as a contact on the website project"
          disabled={pending}
        />
      </div>
      <div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </button>
      </div>
    </form>
  );
}
