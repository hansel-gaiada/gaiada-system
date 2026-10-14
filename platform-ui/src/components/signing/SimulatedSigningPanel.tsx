import Link from "next/link";
import { Card } from "@/components/ui";
import type { SimulatedEnvelopeView } from "@/lib/simulatedPsre";
import { SimulatedSignForm, type SignAction } from "./SimulatedSignForm";
import "./simulatedPsre.css";

// PV5-11 — below the document: the sign form when the BACKEND said `canSign`, otherwise the state in words. When this
// caller's own signer row already reads "signed", the page says so (the durable confirmation, from the recorded signer,
// not from the form's local state, which unmounts when the page re-reads). Otherwise the backend's `reason` is shown;
// the page never invents one beyond a neutral fallback.
export function SimulatedSigningPanel({ view, variant, action, submitLabel, back, clientId }: {
  view: SimulatedEnvelopeView;
  variant: "portal" | "staff";
  action: SignAction;
  submitLabel: string;
  back: { href: string; label: string };
  clientId?: string;
}) {
  const mine = view.signers.find((s) => s.role === view.yourRole);
  const mineSigned = mine?.state === "signed";

  if (view.canSign) {
    return (
      <Card title="Sign">
        <SimulatedSignForm
          variant={variant}
          action={action}
          envelopeId={view.envelopeId}
          contractId={view.contractId}
          clientId={clientId}
          documentSha256={view.documentSha256}
          submitLabel={submitLabel}
          back={back}
        />
      </Card>
    );
  }
  return (
    <Card title="Signing">
      <div className="sp-stack">
        {mineSigned ? (
          <p className="sp-ok" role="status">
            Signed at the simulated PSrE{view.status === "completed" ? ". Every signer has signed." : ". Waiting for the other signer."}{" "}
            This is not a real PSrE signature.
          </p>
        ) : (
          <p className="sp-reason">{view.reason ?? "You can't sign here right now."}</p>
        )}
        <Link className="sp-link" href={back.href}>{back.label}</Link>
      </div>
    </Card>
  );
}
