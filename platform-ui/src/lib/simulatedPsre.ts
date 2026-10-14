// PV5-11 — the SIMULATED certified-signature provider ("PSrE", review stage; owner ruling PV-D43): types and the pure words.
//
// Client-safe on purpose (no `server-only`, no I/O). The readers are in `simulatedPsre-data.ts`, the writes are
// `portalSignSimulatedPsre` (lib/portalActions.ts, the client) and `countersignSimulatedPsreAction`
// (lib/contractsActions.ts, our company's countersigner).
//
// Backend: `platform-nest/src/signatures/simulated-psre.controller.ts`. The server flag `SIGNATURE_SIMULATION_ENABLED` turns
// the pages' API into 404s. Everything here is the backend's field: `canSign`, `reason`, `yourRole` and `notice` are never
// derived from a role in the browser.

export interface SimulatedSigner {
  role: "client" | "countersigner";
  displayName: string;
  state: "pending" | "signed";
  signerName: string | null;
  signerTitle: string | null;
  signedAt: string | null;
}

export interface SimulatedEnvelopeView {
  envelopeId: string;
  provider: string | null;
  label: string | null;
  simulated: boolean;
  /** "Simulated certified signature: not a real PSrE signature". Shown as the backend wrote it. */
  notice: string;
  title: string;
  status: "pending" | "completed";
  completedAt: string | null;
  contractId: string;
  clientId: string;
  contractStatus: string | null;
  contentSha256: string | null;
  documentFilename: string | null;
  documentContentType: string | null;
  documentSha256: string | null;
  /** The text of the document when the simulator holds it as text; otherwise null and the page links `documentPath`. */
  documentText: string | null;
  /** A platform path, used as is for the download link. */
  documentPath: string;
  signers: SimulatedSigner[];
  yourRole: "client" | "countersigner";
  canSign: boolean;
  /** Why `canSign` is false, in words. Null when it is true. */
  reason: string | null;
}

/** The fixed words of the banner when the backend sent no `notice` (an older or odd reply never hides the fact). */
export const SIMULATED_NOTICE_FALLBACK = "Simulated certified signature: not a real PSrE signature";

/** What a signer row says, in words. */
export function signerStateText(s: Pick<SimulatedSigner, "state" | "signerName" | "signerTitle" | "signedAt">, formatDate: (iso: string) => string): string {
  if (s.state !== "signed") return "Not signed yet";
  const who = s.signerName ? s.signerName + (s.signerTitle ? `, ${s.signerTitle}` : "") : "Signed";
  return s.signedAt ? `${who}, ${formatDate(s.signedAt)}` : who;
}

/** The sign and countersign routes' refusals, in plain words. Branch on `reason`, never on the message text. */
export function simulatedSignErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 409 && reason === "content_changed") return "The document changed since you opened this page. We've reloaded it. Please read it again before signing.";
  if (status === 409 && reason === "not_sent") return "This agreement has not been sent for signing, so it cannot be signed yet.";
  if (status === 403 && reason === "signer_must_be_a_person") return "A person has to sign. Sign in with your own account.";
  if (status === 404) return "This signing page is not available. The simulated signing may be switched off.";
  return message;
}

/** The start route's refusals (`POST …/certified-signing`), in plain words. */
export function certifiedStartErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 409) {
    switch (reason) {
      case "content_changed":
      case "content_mismatch":
        return "This agreement changed since you opened it. We've reloaded it. Please read it again before signing.";
      case "no_certified_provider":
        return "Certified signing isn't set up right now. Your account manager will tell you when you can sign.";
      case "already_signed":
        return "This agreement is already signed.";
      default:
        return message;
    }
  }
  if (status === 403) return "Your access to this portal is view-only, so a colleague with signing rights needs to sign this.";
  if (status === 404) return "This agreement could not be found.";
  return message;
}
