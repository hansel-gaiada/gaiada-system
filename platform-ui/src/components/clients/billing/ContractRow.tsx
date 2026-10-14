"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import {
  countersignContractAction, markCertifiedAction, sendContractAction, voidContractAction, type BillingActionState,
} from "@/lib/contractsActions";
import { contractDocumentState, DOCUMENT_PREPARING_TEXT, tierLabel } from "@/lib/billingView";
import { CopyHash } from "@/components/billing/CopyHash";
import { awaitingText, certifiedWaitingText, contractActions, signatureLine, type Contract, type ContractSignature } from "@/lib/contracts";
import { formatDate, money } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { ClientVisibilityMarker } from "../ClientVisibilityMarker";
import { ContractForm } from "./ContractForm";
import { FileLink } from "./FileLink";
import "./billing.css";

// PV3-08 — one contract and the buttons that apply to it.
//
// WHAT IS OFFERED COMES FROM `contractActions()` (lib/contracts.ts), which the unit tests pin:
//   - Edit: a draft only.
//   - Send: a draft only, and DISABLED WITH ITS REASON when there is neither terms nor a file. The reason
//     is text next to the button (and the button's described-by), not a tooltip: a disabled control with no
//     explanation reads as broken.
//   - Countersign: ONLY when the backend said `canCountersign`. No role is read in the browser; a company
//     admin never sees the button, and a stale page cannot offer it for a row that is no longer waiting on us.
//   - Void: any state but void, behind a confirm.
//   - Mark certified (PV5-09): a draft only, and ONLY while the backend says `certifiedSigning.available` (PV5-F4, owner
//     ruling PV-D44: simple signing only). Unavailable: nothing is rendered, no disabled button. The server answers 409
//     `no_certified_provider` if it is ever called.
//
// PV5-09 also shows what the contract IS: its signing tier, the content fingerprint (the SHA-256 fixed when it was sent, in
// short form with a copy button) and, once both parties have signed, the sealed signed copy (or "being prepared": the
// file is rendered after the commit, and an older server omits the field). Every one of these is the backend's field:
// a missing one says "not recorded", never a guess.
//
// PV5-11 (certified signing through the SIMULATED PSrE, owner ruling PV-D43), all from the backend's fields on the row:
//   - Mark certified is enabled from `certifiedSigning.available`, not from a constant here.
//   - A certified contract is countersigned at the provider: a LINK styled as the Countersign button, shown only when the
//     backend said `canCountersignAtProvider` and gave a `countersignUrl`. The typed Countersign never shows for it
//     (`canCountersign` is false for a certified row).
//   - Before the client has started signing there is no envelope yet, and the row says it is waiting for the client.
//   - The Signing fact says "simulated: not a real PSrE signature" when `signatureSimulated`; the signed copy is the
//     "Certified copy" (the provider's signed PDF), not the sealed one.
//
// A refusal the server gives (a 403, a 400) is shown in words under the row, never swallowed.

function Msg({ state }: { state: BillingActionState | null }) {
  if (!state) return null;
  if (!state.ok && state.error) return <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>;
  if (state.ok && state.notice) return <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>;
  return null;
}

/** What a certified contract with an envelope at the provider is waiting for, from the signature rows the backend sent. */
function providerWaitingText(c: Contract): string | null {
  if (c.status !== "sent") return null;
  const label = c.certifiedSigning?.label ?? "the signing provider";
  if (c.clientSigned && !c.providerSigned) return `The client has signed at ${label}. Waiting for our countersignature there.`;
  if (!c.clientSigned) return `Waiting for the client to sign at ${label}.`;
  return null;
}

export function ContractRow({
  contract,
  clientId,
  projects,
  signatures,
  signaturesRefused,
}: {
  contract: Contract;
  clientId: string;
  projects: { id: string; name: string }[] | null;
  /** The detail read's signatures, for a sent contract. `undefined` when none were requested. */
  signatures?: ContractSignature[];
  /** The detail read failed or was refused: say we cannot tell, never "nobody has signed". */
  signaturesRefused?: string;
}) {
  const a = contractActions(contract);
  const [panel, setPanel] = useState<"edit" | "sign" | null>(null);
  const [sendState, sendAction, sending] = useActionState<BillingActionState | null, FormData>(sendContractAction, null);
  const [voidState, voidAction, voiding] = useActionState<BillingActionState | null, FormData>(voidContractAction, null);
  const [signState, signAction, signing] = useActionState<BillingActionState | null, FormData>(countersignContractAction, null);
  const [certState, certAction, certifying] = useActionState<BillingActionState | null, FormData>(markCertifiedAction, null);
  const certifiedRow = contract.certifiedRequested === true || contract.signatureTier === "certified" || Boolean(contract.signatureProvider);
  const providerLabel = contract.certifiedSigning?.label ?? null;
  // The envelope is at the provider: the typed words ("waiting for our countersignature") do not apply, the provider's do.
  const certifiedWaiting = certifiedWaitingText(contract);
  const waiting = certifiedRow ? (certifiedWaiting ?? providerWaitingText(contract)) : awaitingText(contract);
  const sendReasonId = `send-reason-${contract.id}`;
  const certReasonId = `cert-reason-${contract.id}`;
  const signedCopy = contractDocumentState(contract);
  const dates = [contract.startsOn, contract.endsOn].filter(Boolean).map((d) => formatDate(d)).join(" to ");

  return (
    <li className="bl-contract" style={{ listStyle: "none" }}>
      <div className="bl-contract__head">
        <h4 className="bl-contract__title">{contract.title}</h4>
        <span>
          <StatusBadge label={contract.status} />
          {/* PV3-09: the backend's `clientVisible` (a draft is Internal until it is sent; BFF §22d). */}
          <ClientVisibilityMarker clientVisible={contract.clientVisible} />
        </span>
      </div>
      <p className="bl-contract__meta">
        {[
          contract.reference ? `Ref ${contract.reference}` : null,
          contract.version > 1 ? `Version ${contract.version}` : null,
          contract.projectName ? `Project: ${contract.projectName}` : "Whole relationship",
          contract.value != null ? money(contract.value, contract.currency) : null,
          dates || null,
          contract.sentAt ? `Sent ${formatDate(contract.sentAt)}` : null,
          contract.signedAt ? `Signed ${formatDate(contract.signedAt)}` : null,
        ].filter(Boolean).join(" · ")}
        {/* The PDF is a download through the UI's staff file route, which keeps it an attachment. */}
        {contract.fileId && <>{" · "}<FileLink fileId={contract.fileId} label="PDF attached" /></>}
      </p>

      {contract.declineReason && <p className="bl-contract__meta">Declined: {contract.declineReason}</p>}

      <div className="bl-contract__facts">
        <p className="bl-contract__meta">
          <span className="bl-contract__k">Signing</span>{" "}
          {contract.certifiedRequested === true && contract.status === "draft"
            ? "Marked certified. It will be signed through a certified provider once it is sent."
            : contract.signatureTier || contract.status === "draft"
              ? tierLabel(contract.signatureTier, contract.signatureSimulated === true)
              : "The tier was not recorded for this contract."}
        </p>
        {contract.contentSha256 ? (
          <p className="bl-contract__meta"><CopyHash hash={contract.contentSha256} /></p>
        ) : contract.sentAt ? (
          <p className="bl-contract__meta">
            <span className="bl-contract__k">Content fingerprint</span> Not recorded. This contract was sent before the content was fixed at send.
          </p>
        ) : null}
        {contract.status === "signed" && (
          <p className="bl-contract__meta">
            <span className="bl-contract__k">Signed copy</span>{" "}
            {signedCopy.kind === "link"
              ? <FileLink
                  fileId={signedCopy.fileId}
                  label={certifiedRow ? (contract.signatureSimulated === true || contract.certifiedSigning?.simulated === true ? "Certified copy (simulated)" : "Certified copy") : "Sealed signed copy"}
                />
              : DOCUMENT_PREPARING_TEXT}
          </p>
        )}
      </div>

      {contract.status === "sent" && (
        <>
          {signaturesRefused ? (
            <p className="bl-msg bl-msg--error">Who has signed cannot be read right now ({signaturesRefused}). That is not a statement that nobody has.</p>
          ) : signatures && signatures.length > 0 ? (
            <ul className="bl-contract__sigs" aria-label="Signatures">
              {signatures.map((s) => <li key={`${s.party}-${s.signedAt}`}>{signatureLine(s, formatDate, providerLabel)}</li>)}
            </ul>
          ) : null}
          {waiting && <p className="bl-contract__waiting">{waiting}</p>}
        </>
      )}

      <div className="bl-contract__actions">
        {a.edit && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setPanel(panel === "edit" ? null : "edit")} aria-expanded={panel === "edit"}>
            Edit
          </button>
        )}
        {a.send.shown && (
          <form action={sendAction}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="contractId" value={contract.id} />
            <button
              type="submit" className="lux-btn lux-btn--solid lux-btn--sm"
              disabled={!a.send.enabled || sending}
              aria-describedby={a.send.reason ? sendReasonId : undefined}
              onClick={(e) => {
                if (!window.confirm("Send this contract to the client? They are notified and can sign it from their portal.")) e.preventDefault();
              }}
            >
              {sending ? "Sending…" : "Send to client"}
            </button>
          </form>
        )}
        {a.send.reason && <span className="bl-reason" id={sendReasonId}>{a.send.reason}</span>}
        {a.markCertified.shown && (
          <form action={certAction}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="contractId" value={contract.id} />
            <button
              type="submit" className="lux-btn lux-btn--ghost lux-btn--sm"
              disabled={!a.markCertified.enabled || certifying}
              aria-describedby={a.markCertified.reason ? certReasonId : undefined}
            >
              {certifying ? "Marking…" : "Mark certified"}
            </button>
          </form>
        )}
        {a.markCertified.shown && a.markCertified.reason && <span className="bl-reason" id={certReasonId}>{a.markCertified.reason}</span>}
        {a.countersignAtProvider && contract.countersignUrl && (
          <Link href={contract.countersignUrl} className="lux-btn lux-btn--solid lux-btn--sm">
            {`Countersign at ${providerLabel ?? "the signing provider"}`}
          </Link>
        )}
        {a.countersign && (
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setPanel(panel === "sign" ? null : "sign")} aria-expanded={panel === "sign"}>
            Countersign
          </button>
        )}
        {a.void && (
          <form action={voidAction}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="contractId" value={contract.id} />
            <button
              type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={voiding}
              onClick={(e) => {
                if (!window.confirm(`Void "${contract.title}"? This cancels the contract and cannot be undone.`)) e.preventDefault();
              }}
            >
              {voiding ? "Voiding…" : "Void"}
            </button>
          </form>
        )}
      </div>

      <Msg state={sendState} />
      <Msg state={voidState} />
      <Msg state={certState} />

      {panel === "edit" && a.edit && (
        <ContractForm clientId={clientId} projects={projects} contract={contract} onDone={() => setPanel(null)} />
      )}

      {panel === "sign" && a.countersign && (
        <form action={signAction} className="bl-form" aria-label="Countersign this contract">
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="contractId" value={contract.id} />
          <p className="bl-form__hint">
            This signs for our company and binds it to the terms above. The contract becomes <strong>Signed</strong> once
            both parties have signed, in either order, so it may stay Sent until the client signs too.
          </p>
          <div className="lux-form-grid">
            <label className="lux-field">
              <span className="lux-field__label lux-field__label--req">Your full name</span>
              <input className="lux-field__control" name="signerName" required minLength={2} autoComplete="name" disabled={signing} />
            </label>
            <label className="lux-field">
              <span className="lux-field__label">Your title</span>
              <input className="lux-field__control" name="signerTitle" autoComplete="organization-title" disabled={signing} />
            </label>
          </div>
          <div className="bl-form__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={signing}>
              {signing ? "Signing…" : "Countersign"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setPanel(null)} disabled={signing}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <Msg state={signState} />
    </li>
  );
}
