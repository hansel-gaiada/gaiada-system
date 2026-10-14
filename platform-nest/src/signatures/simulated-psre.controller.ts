// PV5-11 / PV-D43 (REVIEW STAGE ONLY) — the SIMULATED PSrE's signing pages, as an API for our UI's two labelled pages
// (FRONTEND-BFF-CONTRACT §30d). They stand where a real provider's own web pages would be: the client signs on one, our
// countersigner on the other, and what they record is recorded AT THE SIMULATOR, which then sends its notice to the
// ERP's webhook like any provider. Nothing here writes a contract signature; only the re-fetch does (certified-signing.ts).
//
//   GET  :tenantId/portal/simulated-psre/envelopes/:envelopeId            the client's view of the envelope
//   GET  :tenantId/portal/simulated-psre/envelopes/:envelopeId/document   the simulator's copy of the document
//   POST :tenantId/portal/simulated-psre/envelopes/:envelopeId/sign       the client signs
//   GET  :tenantId/simulated-psre/envelopes/:envelopeId                   the countersigner's view
//   GET  :tenantId/simulated-psre/envelopes/:envelopeId/document
//   POST :tenantId/simulated-psre/envelopes/:envelopeId/countersign       our countersigner signs
//
// Every route answers 404 while SIGNATURE_SIMULATION_ENABLED is off (the flag guard runs before authentication, so an
// off simulator looks like no route for everyone).
//
// WHO MAY SIGN (the simulator has no KYC, so the ERP's own rules stand in for it, and run FIRST):
//   * client      : Cerbos `portal` / `sign`; a person (signer-checks.ts); the envelope's contract through the caller's
//                   PORTAL SCOPE (another client's contact, or anyone out of scope, gets 404); the signer capability on
//                   that contract's client (403 view-only). The same rules as the typed-name sign route.
//   * countersign : Cerbos `contract` / `countersign` (an owner of the contract's company, or platform_admin; a
//                   company_admin is refused, 403); a person. Then the envelope's contract in this company (404).
// The body comes last: agreement ticked, a typed name, and the SHA-256 of the document the page showed, which must be the
// hash the simulator holds (409 `content_changed` otherwise).
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Req, Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { config } from "../config";
import { authorize } from "../core/http";
import { AuthGuard } from "../auth/guards";
import { check } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import { scrubText } from "../core/scrub";
import { storage } from "../core/storage";
import { canSignFor, requireSignerFor, resolvePortalScope, scopeValues, type PortalScope } from "../core/portal-scope";
import { contractInPortalScope, scopeAt } from "../core/portal-visibility";
import type { SignerRole } from "./provider";
import {
  deliverSimulatedNotices, getSimulatedEnvelope, recordSimulatedSignature, SIMULATED_PROVIDER, SimulatedPsreError,
  type SimulatedEnvelope, type SimulatedSignResult,
} from "./simulated-psre";
import { SIMULATED_LABEL } from "./simulated-provider";
import { requirePersonSigner } from "./signer-checks";

/** 404 for every route while the simulation is off. */
@Injectable()
export class SignatureSimulationFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (!config.signatureSimulationEnabled) throw new NotFoundException("not found");
    return true;
  }
}

export const SIMULATED_NOTICE_TEXT = "Simulated certified signature: not a real PSrE signature";
/** Inline text is offered for a text document up to this size; anything else is a download. */
const INLINE_TEXT_MAX = 256 * 1024;

interface EnvelopeContract {
  id: string;
  clientId: string;
  status: string;
  contentSha256: string | null;
}

export interface SimulatedEnvelopeView {
  envelopeId: string;
  provider: string;
  label: string;
  simulated: true;
  notice: string;
  title: string;
  status: "pending" | "completed";
  completedAt: string | null;
  contractId: string;
  contractStatus: string;
  /** The contract's hash fixed at send; equals documentSha256 for an envelope created from it. */
  contentSha256: string | null;
  documentFilename: string;
  documentContentType: string;
  documentSha256: string;
  /** The document's text, when it is a small text document (the agreement written in the ERP). */
  documentText: string | null;
  /** The API path that streams the simulator's copy of the document (relative to the platform). */
  documentPath: string;
  signers: Array<{ role: SignerRole; displayName: string; state: "pending" | "signed"; signerName: string | null; signerTitle: string | null; signedAt: string | null }>;
  yourRole: SignerRole;
  canSign: boolean;
  /** Why not, in words, when `canSign` is false and the slot is not already signed. */
  reason: string | null;
}

function dispositionHeader(filename: string): string {
  const ascii = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function viewOf(
  e: SimulatedEnvelope, k: EnvelopeContract, role: SignerRole, maySign: boolean, documentPath: string, refusal: string | null,
): Promise<SimulatedEnvelopeView> {
  const slot = e.signers.find((s) => s.role === role);
  let documentText: string | null = null;
  if (/^text\//i.test(e.documentContentType)) {
    try {
      const bytes = await storage().get(e.documentStorageKey);
      if (bytes.byteLength <= INLINE_TEXT_MAX) documentText = bytes.toString("utf8");
    } catch {
      documentText = null;
    }
  }
  let reason: string | null = null;
  if (!slot) reason = "this envelope has no signer slot for you";
  else if (slot.state === "signed") reason = null;
  else if (e.status === "completed") reason = "this envelope is already complete";
  else if (k.status !== "sent") reason = `this agreement is ${k.status} and cannot be signed`;
  else if (!maySign) reason = refusal;
  const canSign = !!slot && slot.state === "pending" && e.status === "pending" && k.status === "sent" && maySign;
  return {
    envelopeId: e.id,
    provider: SIMULATED_PROVIDER,
    label: SIMULATED_LABEL,
    simulated: true,
    notice: SIMULATED_NOTICE_TEXT,
    title: e.title,
    status: e.status,
    completedAt: e.completedAt,
    contractId: k.id,
    contractStatus: k.status,
    contentSha256: k.contentSha256,
    documentFilename: e.documentFilename,
    documentContentType: e.documentContentType,
    documentSha256: e.documentSha256,
    documentText,
    documentPath,
    signers: e.signers.map((s) => ({
      role: s.role, displayName: s.displayName, state: s.state, signerName: s.signerName, signerTitle: s.signerTitle, signedAt: s.signedAt,
    })),
    yourRole: role,
    canSign,
    reason: canSign ? null : reason,
  };
}

/** The body every sign request carries, checked AFTER authorization and reach. */
function signBody(b: { agree?: boolean; signerName?: string; signerTitle?: string; documentSha256?: string } | undefined, e: SimulatedEnvelope) {
  const body = b ?? {};
  if (body.agree !== true) throw new BadRequestException({ message: "you must confirm you agree to the terms", field: "agree" });
  const name = (body.signerName ?? "").trim();
  if (name.length < 2) throw new BadRequestException({ message: "signerName required", field: "signerName" });
  const echoed = typeof body.documentSha256 === "string" ? body.documentSha256.trim().toLowerCase() : "";
  if (!echoed) throw new BadRequestException({ message: "documentSha256 is required: reload the page and sign again", reason: "content_hash_required" });
  if (echoed !== e.documentSha256) {
    throw new ConflictException({ message: "this document changed since you opened it; reload it and read it again before signing", reason: "content_changed" });
  }
  return {
    signerName: scrubText(name).text.slice(0, 200),
    signerTitle: body.signerTitle ? scrubText(body.signerTitle).text.slice(0, 200) : null,
  };
}

function simulatorError(err: unknown): never {
  if (err instanceof SimulatedPsreError) {
    if (err.code === "unknown_envelope") throw new NotFoundException("envelope not found");
    throw new ConflictException({ message: err.message, reason: err.code });
  }
  throw err;
}

/** A soft probe (a UI hint, never a refusal): may this staff caller countersign in this company? Mirrors authorize()'s
 *  delegation rule the way contracts.controller.ts mayCountersign does: any failure reads false. */
async function mayCountersign(p: Principal, tenantId: string, contractId: string): Promise<boolean> {
  try {
    if (!p.userId || p.via || p.actFor || p.kind === "automation" || p.kind === "bot") return false;
    return (await check(p, { kind: "contract", id: contractId, tenantId }, "countersign")).allow;
  } catch {
    return false;
  }
}

@Controller("api")
@UseGuards(SignatureSimulationFlagGuard, AuthGuard)
export class SimulatedPsreController {
  // ── the client's page ─────────────────────────────────────────────────────────────────────────────

  /** The envelope's contract through the caller's portal scope, or 404. */
  private async portalReach(req: FastifyRequest, tenantId: string, envelopeId: string): Promise<{ e: SimulatedEnvelope; k: EnvelopeContract; scope: PortalScope }> {
    const found = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const r = await c.query<EnvelopeContract>(
        `SELECT k.id, k.client_id AS "clientId", k.status, k.content_sha256 AS "contentSha256"
           FROM contracts k
          WHERE k.signature_provider = $1 AND k.provider_envelope_id = $5 AND ${contractInPortalScope("k", { clients: 2, wide: 3, projects: 4 })}`,
        [SIMULATED_PROVIDER, ...scopeValues(scope), envelopeId],
      );
      return { k: r.rows[0] ?? null, scope };
    });
    if (!found.k) throw new NotFoundException("envelope not found");
    const e = await getSimulatedEnvelope(tenantId, envelopeId);
    if (!e) throw new NotFoundException("envelope not found");
    return { e, k: found.k, scope: found.scope };
  }

  @Get(":tenantId/portal/simulated-psre/envelopes/:envelopeId")
  async portalView(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("envelopeId") envelopeId: string): Promise<SimulatedEnvelopeView> {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const { e, k, scope } = await this.portalReach(req, tenantId, envelopeId);
    const signer = canSignFor(scope, k.clientId);
    let personOk = true;
    try { requirePersonSigner(req.principal); } catch { personOk = false; }
    const refusal = !signer
      ? "your access is view-only, so a colleague with signing rights needs to sign this"
      : "only a person signed in to their own session can sign";
    return viewOf(e, k, "client", signer && personOk, `/api/${tenantId}/portal/simulated-psre/envelopes/${e.id}/document`, refusal);
  }

  @Get(":tenantId/portal/simulated-psre/envelopes/:envelopeId/document")
  async portalDocument(
    @Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("envelopeId") envelopeId: string,
  ): Promise<void> {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const { e } = await this.portalReach(req, tenantId, envelopeId);
    await this.sendDocument(reply, e);
  }

  @Post(":tenantId/portal/simulated-psre/envelopes/:envelopeId/sign")
  @HttpCode(200)
  async portalSign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("envelopeId") envelopeId: string,
    @Body() body: { agree?: boolean; signerName?: string; signerTitle?: string; documentSha256?: string },
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "sign");
    requirePersonSigner(req.principal);
    const { e, k, scope } = await this.portalReach(req, tenantId, envelopeId);
    requireSignerFor(scope, k.clientId);
    const who = signBody(body, e);
    if (k.status !== "sent") throw new ConflictException({ message: `this agreement is ${k.status} and cannot be signed`, reason: "not_sent" });
    return this.sign(tenantId, e.id, "client", { signerRef: req.principal.userId as string, ...who });
  }

  // ── the countersigner's page ──────────────────────────────────────────────────────────────────────

  private async staffReach(tenantId: string, envelopeId: string): Promise<{ e: SimulatedEnvelope; k: EnvelopeContract }> {
    const r = await withTenants([tenantId], (c) =>
      c.query<EnvelopeContract>(
        `SELECT id, client_id AS "clientId", status, content_sha256 AS "contentSha256"
           FROM contracts WHERE signature_provider = $1 AND provider_envelope_id = $2 AND deleted_at IS NULL`,
        [SIMULATED_PROVIDER, envelopeId],
      ),
    );
    const k = r.rows[0];
    if (!k) throw new NotFoundException("envelope not found");
    const e = await getSimulatedEnvelope(tenantId, envelopeId);
    if (!e) throw new NotFoundException("envelope not found");
    return { e, k };
  }

  @Get(":tenantId/simulated-psre/envelopes/:envelopeId")
  async staffView(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("envelopeId") envelopeId: string): Promise<SimulatedEnvelopeView> {
    await authorize(req.principal, { kind: "contract", tenantId }, "read");
    const { e, k } = await this.staffReach(tenantId, envelopeId);
    const may = await mayCountersign(req.principal, tenantId, k.id);
    return viewOf(e, k, "countersigner", may, `/api/${tenantId}/simulated-psre/envelopes/${e.id}/document`,
      "only an owner of this company can countersign for it");
  }

  @Get(":tenantId/simulated-psre/envelopes/:envelopeId/document")
  async staffDocument(
    @Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("envelopeId") envelopeId: string,
  ): Promise<void> {
    await authorize(req.principal, { kind: "contract", tenantId }, "read");
    const { e } = await this.staffReach(tenantId, envelopeId);
    await this.sendDocument(reply, e);
  }

  @Post(":tenantId/simulated-psre/envelopes/:envelopeId/countersign")
  @HttpCode(200)
  async staffCountersign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("envelopeId") envelopeId: string,
    @Body() body: { agree?: boolean; signerName?: string; signerTitle?: string; documentSha256?: string },
  ) {
    // AUTHORIZE FIRST: the countersign rule depends only on the company (contracts.controller.ts mayCountersign), so a
    // company_admin is refused before the envelope is even looked up. Then once more against the contract itself.
    await authorize(req.principal, { kind: "contract", tenantId }, "countersign");
    requirePersonSigner(req.principal);
    const { e, k } = await this.staffReach(tenantId, envelopeId);
    await authorize(req.principal, { kind: "contract", id: k.id, tenantId }, "countersign");
    const who = signBody(body, e);
    if (k.status !== "sent") throw new ConflictException({ message: `this agreement is ${k.status} and cannot be signed`, reason: "not_sent" });
    return this.sign(tenantId, e.id, "countersigner", { signerRef: req.principal.userId as string, ...who });
  }

  // ── shared ────────────────────────────────────────────────────────────────────────────────────────

  private async sign(tenantId: string, envelopeId: string, role: SignerRole, who: { signerRef: string; signerName: string; signerTitle: string | null }) {
    let res: SimulatedSignResult;
    try {
      res = await recordSimulatedSignature(tenantId, envelopeId, role, who);
    } catch (err) {
      simulatorError(err);
    }
    // The provider tells the ERP, after its own commit, over the real webhook (best effort; the ERP's sweep catches up).
    const delivered = await deliverSimulatedNotices(res.notices);
    return {
      ok: true,
      simulated: true,
      outcome: res.outcome,
      completed: res.completed,
      noticesDelivered: delivered.filter((s) => s === 200).length,
    };
  }

  private async sendDocument(reply: FastifyReply, e: SimulatedEnvelope): Promise<void> {
    const bytes = await storage().get(e.documentStorageKey);
    await reply
      .header("content-disposition", dispositionHeader(e.documentFilename))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(e.documentContentType || "application/octet-stream")
      .send(bytes);
  }
}
