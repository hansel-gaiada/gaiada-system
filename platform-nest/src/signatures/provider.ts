// PV5-11 — the SignatureProvider seam (plan design decision 14). The platform talks to a certified-signature provider
// (a PSrE) ONLY through this file's shapes. Today there is ONE implementation, the SIMULATED PSrE (simulated-provider.ts,
// owner ruling PV-D43: review stage only). The real PSrE (VIDA, PV-D25) is a second adapter that satisfies this file;
// no controller, no processing code and no table names a vendor field.
//
// The shapes are VIDA's as far as its public docs go (docs/blueprints/pv5-provider-comparison.md §1.3 and §4):
//   * an ENVELOPE is created from one document with a list of signers, under OUR reference (`partnerRef`, VIDA's
//     partnerTrxId), and creating it again with the same reference must return the same envelope (a retry never pays twice);
//   * each signer signs on the PROVIDER'S page (`signingUrl`);
//   * the provider tells us something happened with a NOTICE authenticated by a SHARED CREDENTIAL ONLY (VIDA's webhook
//     carries no HMAC: Basic or OAuth2). A notice is therefore a trigger and nothing more: what happened is always read
//     back with `getEnvelopeStatus` (design decision 15). That re-fetch is the only integrity control on this path;
//   * on completion the signed PDF and the certificate it was signed with are DOWNLOADED and kept by us (the custody exit
//     in the vendor-exit row, blueprint §1.4).

/** Which slot a signer fills. `countersigner` is our company's authorised signatory. */
export type SignerRole = "client" | "countersigner";

/** The fixed content an envelope is created from: the exact bytes whose SHA-256 is `contracts.content_sha256`. */
export interface EnvelopeDocument {
  bytes: Buffer;
  filename: string;
  contentType: string;
  /** SHA-256 of `bytes`, lower-case hex. The caller has already checked it equals the contract's fixed hash. */
  sha256: string;
}

export interface EnvelopeSigner {
  role: SignerRole;
  /** What the provider shows for the slot before anyone signs ("the client's signer", "<legal name>, authorised signatory"). */
  displayName: string;
}

export interface CreateEnvelopeRequest {
  /** Our reference, echoed in every notice and status ("<tenant id>:<contract id>"). One envelope per reference. */
  partnerRef: string;
  title: string;
  document: EnvelopeDocument;
  signers: EnvelopeSigner[];
}

export interface EnvelopeCreated {
  envelopeId: string;
  /** SHA-256 of the document the PROVIDER holds (computed by it). Must equal what we sent. */
  documentSha256: string;
}

/**
 * The provider's own account of an envelope (read from its status API, the only source anything is written from).
 *   pending   : at least one signer has not signed
 *   completed : every signer signed and the signed document can be downloaded
 *   declined  : a signer refused (the simulator never produces it; a real PSrE can)
 *   expired   : the envelope lapsed
 *   unknown   : the provider has no such envelope, or a state we do not recognise. Never treated as signed.
 */
export type EnvelopeState = "pending" | "completed" | "declined" | "expired" | "unknown";

export interface EnvelopeSignerStatus {
  role: SignerRole;
  state: "pending" | "signed" | "declined";
  /** ISO 8601, when signed. */
  signedAt: string | null;
  /** The name the signer signed with, as the provider recorded it. */
  signerName: string | null;
  signerTitle: string | null;
  /** The provider's reference for WHO signed. For the simulator: the ERP user id of the person whose session signed. */
  signerRef: string | null;
}

export interface EnvelopeStatus {
  envelopeId: string;
  partnerRef: string;
  state: EnvelopeState;
  documentSha256: string;
  signers: EnvelopeSignerStatus[];
  completedAt: string | null;
}

export interface SignedDocument {
  pdf: Buffer;
  /** The certificate the provider signed the PDF with (PEM). Public material only. */
  certificatePem: string;
}

export interface SignedDocumentVerification {
  ok: boolean;
  reason?: string;
}

/** A notice that passed authentication. Nothing in it is trusted beyond "the provider sent this". */
export interface VerifiedSignatureNotice {
  /** The dedupe key claimed in `provider_events.event_id` (unique per provider). */
  eventKey: string;
  /** The envelope the notice is about (`provider_events.ref`). */
  envelopeId: string;
  /** Our reference, as the notice states it (only used to find the company the notice is filed under). */
  partnerRef: string;
  /** A small, scrubbed copy of the notice for the audit trail (strings only). */
  summary: Record<string, string>;
}

export type SignatureNoticeVerification = { ok: true; notice: VerifiedSignatureNotice } | { ok: false; reason: string };

/** The provider could not be reached or answered with a server error: transient, retry later. */
export class SignatureProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureProviderUnavailableError";
  }
}

/** The provider refused the request itself (unknown envelope, a malformed answer, a document it would not take). */
export class SignatureProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureProviderRequestError";
  }
}

/** The provider, for ONE company (a real PSrE account may be per company; the simulator files rows per company). */
export interface SignatureProvider {
  /** The provider key used in URLs and rows (`/api/webhooks/signatures/:provider`, `contracts.signature_provider`). */
  readonly name: string;
  createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeCreated>;
  /** Throws SignatureProviderUnavailableError when transient. An unknown envelope answers `state: "unknown"`. */
  getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus>;
  /** Only for a completed envelope. Throws SignatureProviderRequestError otherwise. */
  downloadSigned(envelopeId: string): Promise<SignedDocument>;
  /** Check a downloaded document BEFORE it is stored: the signature verifies with the delivered certificate, the
   *  certificate is the provider's, and the document carries exactly the content both parties signed. */
  verifySignedDocument(signed: SignedDocument, contentSha256: string): Promise<SignedDocumentVerification>;
  /** Where a signer signs (a path on our UI for the simulator; the provider's own page for a real PSrE). */
  signingUrl(envelopeId: string, role: SignerRole): string;
}

/** The provider as configured on this server (not yet bound to a company). */
export interface SignatureProviderAccount {
  readonly name: string;
  /** What people see: "Simulated PSrE (review stage)". */
  readonly label: string;
  /** True for the review-stage simulation (PV-D43). Every surface that shows a signature through it says SIMULATED. */
  readonly simulated: boolean;
  /** Authenticate a notice by its shared credential. Never throws on a bad request: answers `{ ok: false }`. */
  verifyNotice(authorization: string | undefined, body: unknown): SignatureNoticeVerification;
  forCompany(tenantId: string): SignatureProvider;
}
