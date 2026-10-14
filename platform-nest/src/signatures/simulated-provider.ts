// PV5-11 / PV-D43 — the SignatureProvider adapter for the SIMULATED PSrE (simulated-psre.ts). The only file that turns the
// simulator's functions into the provider shapes (provider.ts); a real PSrE adapter (VIDA) replaces exactly this file's
// role with HTTP calls, and nothing else changes.
import {
  SignatureProviderRequestError, type CreateEnvelopeRequest, type EnvelopeCreated, type EnvelopeStatus, type SignatureNoticeVerification,
  type SignatureProvider, type SignatureProviderAccount, type SignedDocument, type SignedDocumentVerification, type SignerRole,
} from "./provider";
import {
  createSimulatedEnvelope, downloadSimulatedSigned, envelopeStatusOf, getSimulatedEnvelope, isSimulatedNoticeAuthorization,
  SIMULATED_PROVIDER, SimulatedPsreError, verifySimulatedSignedDocument,
} from "./simulated-psre";

export const SIMULATED_LABEL = "Simulated PSrE (review stage)";

/** The UI path of the simulated signing page for each signer (the simulator's "own" pages, served by our UI). */
export function simulatedSigningPath(envelopeId: string, role: SignerRole): string {
  const id = encodeURIComponent(envelopeId);
  return role === "client" ? `/portal/simulated-psre/${id}` : `/simulated-psre/${id}`;
}

class SimulatedSignatureProvider implements SignatureProvider {
  readonly name = SIMULATED_PROVIDER;
  constructor(private readonly tenantId: string) {}

  async createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeCreated> {
    try {
      return await createSimulatedEnvelope(this.tenantId, req);
    } catch (err) {
      if (err instanceof SimulatedPsreError) throw new SignatureProviderRequestError(err.message);
      throw err;
    }
  }

  async getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
    const e = await getSimulatedEnvelope(this.tenantId, envelopeId);
    if (!e) {
      return { envelopeId, partnerRef: "", state: "unknown", documentSha256: "", signers: [], completedAt: null };
    }
    return envelopeStatusOf(e);
  }

  async downloadSigned(envelopeId: string): Promise<SignedDocument> {
    const d = await downloadSimulatedSigned(this.tenantId, envelopeId);
    if (!d) throw new SignatureProviderRequestError("the envelope is not complete, so there is no signed document to download");
    return d;
  }

  verifySignedDocument(signed: SignedDocument, contentSha256: string): Promise<SignedDocumentVerification> {
    return verifySimulatedSignedDocument(signed, contentSha256);
  }

  signingUrl(envelopeId: string, role: SignerRole): string {
    return simulatedSigningPath(envelopeId, role);
  }
}

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The simulated provider account (exists only while SIGNATURE_SIMULATION_ENABLED is on; registry.ts decides). */
export const simulatedAccount: SignatureProviderAccount = {
  name: SIMULATED_PROVIDER,
  label: SIMULATED_LABEL,
  simulated: true,
  verifyNotice(authorization: string | undefined, body: unknown): SignatureNoticeVerification {
    // The shared credential is the ENTIRE authentication (VIDA's shape: no HMAC). Checked first, constant-time.
    if (!isSimulatedNoticeAuthorization(authorization)) return { ok: false, reason: "credential" };
    if (!body || typeof body !== "object") return { ok: false, reason: "malformed" };
    const b = body as Record<string, unknown>;
    const eventId = typeof b.eventId === "string" ? b.eventId : "";
    const envelopeId = typeof b.envelopeId === "string" ? b.envelopeId : "";
    const partnerRef = typeof b.partnerTrxId === "string" ? b.partnerTrxId : "";
    if (!SAFE.test(eventId) || !SAFE.test(envelopeId) || !SAFE.test(partnerRef)) return { ok: false, reason: "malformed" };
    // A small copy for the audit trail. Never used to decide anything: processing re-fetches the envelope.
    const summary: Record<string, string> = { eventId, envelopeId, partnerTrxId: partnerRef };
    for (const k of ["event", "signerRole", "occurredAt"]) {
      const v = b[k];
      if (typeof v === "string" && v.length <= 64) summary[k] = v;
    }
    return { ok: true, notice: { eventKey: eventId, envelopeId, partnerRef, summary } };
  },
  forCompany(tenantId: string): SignatureProvider {
    return new SimulatedSignatureProvider(tenantId);
  },
};
