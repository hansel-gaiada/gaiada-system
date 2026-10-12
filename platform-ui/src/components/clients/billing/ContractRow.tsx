"use client";
import { useActionState, useState } from "react";
import {
  countersignContractAction, sendContractAction, voidContractAction, type BillingActionState,
} from "@/lib/contractsActions";
import { awaitingText, contractActions, signatureLine, type Contract, type ContractSignature } from "@/lib/contracts";
import { formatDate, money } from "@/lib/format";
import { StatusBadge } from "@/components/ui";
import { ContractForm } from "./ContractForm";
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
//
// A refusal the server gives (a 403, a 400) is shown in words under the row, never swallowed.

function Msg({ state }: { state: BillingActionState | null }) {
  if (!state) return null;
  if (!state.ok && state.error) return <p className="bl-msg bl-msg--error" role="alert">{state.error}</p>;
  if (state.ok && state.notice) return <p className="bl-msg bl-msg--ok" role="status">{state.notice}</p>;
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
  const waiting = awaitingText(contract);
  const sendReasonId = `send-reason-${contract.id}`;
  const dates = [contract.startsOn, contract.endsOn].filter(Boolean).map((d) => formatDate(d)).join(" to ");

  return (
    <li className="bl-contract" style={{ listStyle: "none" }}>
      <div className="bl-contract__head">
        <h4 className="bl-contract__title">{contract.title}</h4>
        <StatusBadge label={contract.status} />
      </div>
      <p className="bl-contract__meta">
        {[
          contract.reference ? `Ref ${contract.reference}` : null,
          contract.version > 1 ? `Version ${contract.version}` : null,
          contract.projectName ? `Project: ${contract.projectName}` : "Whole relationship",
          contract.value != null ? money(contract.value, contract.currency) : null,
          dates || null,
          contract.fileId ? "PDF attached" : null,
          contract.sentAt ? `Sent ${formatDate(contract.sentAt)}` : null,
          contract.signedAt ? `Signed ${formatDate(contract.signedAt)}` : null,
        ].filter(Boolean).join(" · ")}
      </p>

      {contract.declineReason && <p className="bl-contract__meta">Declined: {contract.declineReason}</p>}

      {contract.status === "sent" && (
        <>
          {signaturesRefused ? (
            <p className="bl-msg bl-msg--error">Who has signed cannot be read right now ({signaturesRefused}). That is not a statement that nobody has.</p>
          ) : signatures && signatures.length > 0 ? (
            <ul className="bl-contract__sigs" aria-label="Signatures">
              {signatures.map((s) => <li key={`${s.party}-${s.signedAt}`}>{signatureLine(s, formatDate)}</li>)}
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
