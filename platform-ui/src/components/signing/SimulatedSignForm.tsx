"use client";
import { useActionState, useId } from "react";
import Link from "next/link";
import "./simulatedPsre.css";

// PV5-11 — the signing form on a simulated PSrE page: typed full name, optional title, an agreement box, and the document
// hash the page showed (hidden, echoed to the server: a 409 `content_changed` means the document is not what this page
// showed and nothing was signed).
//
// Rendered ONLY when the backend said `canSign: true`. The action is passed in by the page (the client's
// `portalSignSimulatedPsre` or the countersigner's `countersignSimulatedPsreAction`), so this component carries no
// knowledge of who is signing. After the action revalidates, the page re-reads the envelope, `canSign` turns false and this
// form unmounts; the page then shows the same "Signed" statement from the recorded signer, so the confirmation does not
// depend on this component's state.
export interface SignResult { ok: boolean; error?: string; field?: string; id?: string }
export type SignAction = (prev: SignResult | null, formData: FormData) => Promise<SignResult>;

const CLS = {
  portal: { input: "cp-input", field: "cp-field", label: "cp-field__label", hint: "cp-field__hint", button: "btn btn-primary" },
  staff: { input: "lux-field__control", field: "lux-field", label: "lux-field__label", hint: "bl-form__hint", button: "lux-btn lux-btn--solid" },
} as const;

export function SimulatedSignForm({ variant, action, envelopeId, contractId, clientId, documentSha256, submitLabel, back }: {
  variant: "portal" | "staff";
  action: SignAction;
  envelopeId: string;
  contractId: string;
  /** Staff only: the client whose billing tab the countersign refreshes. */
  clientId?: string;
  documentSha256: string | null;
  submitLabel: string;
  back: { href: string; label: string };
}) {
  const [state, formAction, pending] = useActionState<SignResult | null, FormData>(action, null);
  const uid = useId();
  const c = CLS[variant];

  if (state?.ok) {
    return (
      <div className="sp-stack">
        <p className="sp-ok" role="status">Signed at the simulated PSrE. This is not a real PSrE signature.</p>
        <Link className="sp-link" href={back.href}>{back.label}</Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="sp-form" aria-label={submitLabel}>
      <input type="hidden" name="envelopeId" value={envelopeId} />
      <input type="hidden" name="contractId" value={contractId} />
      {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
      <input type="hidden" name="documentSha256" value={documentSha256 ?? ""} />
      {state && !state.ok && state.error ? <p className="sp-error" role="alert">{state.error}</p> : null}

      <div className="sp-form__fields">
        <div className={c.field}>
          <label className={c.label} htmlFor={`${uid}-name`}>Your full name</label>
          <input id={`${uid}-name`} className={c.input} name="signerName" type="text" required minLength={2} maxLength={200}
                 autoComplete="name" disabled={pending} aria-describedby={`${uid}-name-hint`} />
          <span className={c.hint} id={`${uid}-name-hint`}>Type your own name. This is a simulated signature for review.</span>
        </div>
        <div className={c.field}>
          <label className={c.label} htmlFor={`${uid}-title`}>Your job title (optional)</label>
          <input id={`${uid}-title`} className={c.input} name="signerTitle" type="text" maxLength={200}
                 autoComplete="organization-title" disabled={pending} />
        </div>
      </div>

      <label className="sp-check">
        <input type="checkbox" name="agree" value="yes" required disabled={pending} />
        <span>I have read the document above and I agree to its terms.</span>
      </label>

      <div className="sp-form__actions">
        <button type="submit" className={c.button} disabled={pending}>
          {pending ? "Signing…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
