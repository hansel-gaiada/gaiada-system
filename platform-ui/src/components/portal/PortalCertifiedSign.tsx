"use client";
import { useActionState, useEffect, useId } from "react";
import { portalStartCertifiedSigning, type PortalActionResult } from "@/lib/portalActions";
import { isSimulatedSigningUrl, SIMULATED_SIGNATURE_NOTE } from "@/lib/portal";
import "@/components/signing/simulatedPsre.css";

// PV5-11 — "Sign with <provider>": the client's way to sign a CERTIFIED contract. Modelled on PortalPayOnline.
//
// Rendered ONLY when the backend says `certifiedSigning.canStart` on the contract GET; this component never decides who may
// sign and never offers a typed-name signature (a certified contract is not signed by typed name). The press asks the server
// action to start the envelope at the provider; the browser then goes to the signing page, but ONLY when the answered URL is
// a same-site `/portal/simulated-psre/…` path (`isSimulatedSigningUrl`).
//
// While the provider is the SIMULATED PSrE of the review stage, the note says so in plain words, at full contrast (not an
// opacity-dimmed hint): the signature has no legal standing as a certified signature.
//
// `contentSha256` is the hash the page showed. A 409 "changed since you opened it" is shown as an alert and the page is
// reloaded by the server action's revalidation, with the same sentence the typed sign form uses.
export function PortalCertifiedSign({ contractId, contentSha256, label, simulated }: {
  contractId: string;
  contentSha256?: string | null;
  label: string;
  simulated: boolean;
}) {
  const [state, formAction, pending] = useActionState<PortalActionResult | null, FormData>(portalStartCertifiedSigning, null);
  const leaving = state?.ok === true && isSimulatedSigningUrl(state.url);
  const noteId = useId();

  useEffect(() => {
    if (state?.ok && isSimulatedSigningUrl(state.url)) window.location.assign(state.url);
  }, [state]);

  return (
    <form action={formAction} className="cp-form">
      <input type="hidden" name="contractId" value={contractId} />
      {contentSha256 ? <input type="hidden" name="contentSha256" value={contentSha256} /> : null}
      {state && !state.ok && state.error && <div className="cp-form__error" role="alert">{state.error}</div>}
      {leaving && (
        <div className="cp-form__ok" role="status">
          Taking you to the signing page… If nothing happens, <a href={state.url}>open the signing page</a>.
        </div>
      )}
      {simulated && <p className="sp-note" id={noteId}>{SIMULATED_SIGNATURE_NOTE}</p>}
      <p className="cp-field__hint" style={{ margin: 0 }}>
        You&apos;ll read and sign this agreement on the signing provider&apos;s page. Our company signs after you.
      </p>
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending || leaving} aria-describedby={simulated ? noteId : undefined}>
          {pending ? "Opening the signing page…" : `Sign with ${label}`}
        </button>
      </div>
    </form>
  );
}
