// PV5-11 — the ERP's certified-signing routes (FRONTEND-BFF-CONTRACT §30d).
//
//   POST :tenantId/portal/contracts/:contractId/certified-signing          the CLIENT reaches the sign step
//   POST :tenantId/portal/contracts/:contractId/certified-signing/refresh  re-check the envelope (portal)
//   POST :tenantId/contracts/:contractId/certified-signing/refresh         re-check the envelope (staff)
//
// ── THE SIGN STEP CREATES THE ENVELOPE ──────────────────────────────────────────────────────────────
// A PSrE charges per signature, so the envelope is created here, when a client signer presses "Sign with <provider>",
// never at send (blueprint §4). In order: Cerbos `portal` / `sign`; a person, never an agent (signer-checks.ts); the
// contract through the caller's PORTAL SCOPE (out of scope is 404, never 403); the signer capability on THIS contract's
// client; then the body (the hash the client saw, which must be the hash fixed at send); then the provider. The answer
// is the provider's signing page for the client.
//
// ── REFRESH WRITES ONLY WHAT THE PROVIDER SAYS ──────────────────────────────────────────────────────
// The two refresh routes run the same re-fetch-and-apply step a notice runs (certified-signing.ts syncEnvelope). They are
// called when a signer comes back from the provider's page, so the contract page does not wait for the notice or the
// sweep. A READ authorization is enough: what they write is decided entirely by the provider's re-fetched status (the
// unauthenticated webhook triggers exactly the same step), so calling one grants nothing the caller could not see.
import { BadRequestException, ConflictException, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards, Body } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { AuthGuard } from "../auth/guards";
import { requireSignerFor, resolvePortalScope, scopeValues } from "../core/portal-scope";
import { contractInPortalScope, scopeAt } from "../core/portal-visibility";
import { certifiedSigningAccount, signatureAccountNamed } from "./registry";
import { noCertifiedProvider, startCertifiedEnvelope, syncEnvelope, type SyncOutcome } from "./certified-signing";
import { requirePersonSigner } from "./signer-checks";

export interface CertifiedSigningStarted {
  envelopeId: string;
  provider: string;
  label: string;
  simulated: boolean;
  signingUrl: string;
}

export interface CertifiedSigningRefreshed {
  status: SyncOutcome["status"];
  outcome: string;
  contractStatus: string | null;
}

function summarize(s: SyncOutcome): string {
  return "outcome" in s ? s.outcome : s.reason;
}

@Controller("api")
@UseGuards(AuthGuard)
export class CertifiedSigningController {
  @Post(":tenantId/portal/contracts/:contractId/certified-signing")
  @HttpCode(200)
  async start(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
    @Body() body: { contentSha256?: string },
  ): Promise<CertifiedSigningStarted> {
    await authorize(req.principal, { kind: "portal", tenantId }, "sign");
    requirePersonSigner(req.principal);
    const k = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const r = await c.query<{ clientId: string; status: string; tier: string | null; contentSha256: string | null; clientSigned: boolean }>(
        `SELECT k.client_id AS "clientId", k.status, k.signature_tier AS tier, k.content_sha256 AS "contentSha256",
                EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'client') AS "clientSigned"
           FROM contracts k WHERE k.id = $1 AND ${contractInPortalScope("k", scopeAt(2))}`,
        [contractId, ...scopeValues(scope)],
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundException("contract not found");
      requireSignerFor(scope, row.clientId);
      return row;
    });
    const echoed = typeof body?.contentSha256 === "string" ? body.contentSha256.trim().toLowerCase() : "";
    if (!echoed) {
      throw new BadRequestException({ message: "contentSha256 is required: reload the agreement and sign again", reason: "content_hash_required" });
    }
    if (echoed !== k.contentSha256) {
      throw new ConflictException({
        message: "this agreement changed since you opened it; reload it and read it again before signing",
        reason: "content_changed",
      });
    }
    const account = certifiedSigningAccount();
    if (!account) noCertifiedProvider();
    if (k.tier !== "certified") {
      throw new ConflictException({ message: "this agreement is signed by typed name, not through a certified signing provider", reason: "not_certified" });
    }
    if (k.clientSigned) throw new ConflictException({ message: "your organisation has already signed this agreement", reason: "already_signed" });
    if (k.status !== "sent") throw new ConflictException({ message: `this agreement is ${k.status} and cannot be signed`, reason: "not_sent" });

    const started = await startCertifiedEnvelope(account, tenantId, contractId);
    if (started.created) {
      await writeActivity(tenantId, req.principal.userId, "certified_envelope_created", "contract", contractId, {
        provider: account.name, simulated: account.simulated, envelopeId: started.envelopeId, contentSha256: k.contentSha256,
      });
    }
    return {
      envelopeId: started.envelopeId,
      provider: account.name,
      label: account.label,
      simulated: account.simulated,
      signingUrl: account.forCompany(tenantId).signingUrl(started.envelopeId, "client"),
    };
  }

  @Post(":tenantId/portal/contracts/:contractId/certified-signing/refresh")
  @HttpCode(200)
  async portalRefresh(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
  ): Promise<CertifiedSigningRefreshed> {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const found = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const r = await c.query<{ provider: string | null }>(
        `SELECT k.signature_provider AS provider FROM contracts k WHERE k.id = $1 AND ${contractInPortalScope("k", scopeAt(2))}`,
        [contractId, ...scopeValues(scope)],
      );
      return r.rows[0] ?? null;
    });
    if (!found) throw new NotFoundException("contract not found");
    return this.refresh(tenantId, contractId, found.provider);
  }

  @Post(":tenantId/contracts/:contractId/certified-signing/refresh")
  @HttpCode(200)
  async staffRefresh(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("contractId") contractId: string,
  ): Promise<CertifiedSigningRefreshed> {
    await authorize(req.principal, { kind: "contract", id: contractId, tenantId }, "read");
    const found = await withTenants([tenantId], (c) =>
      c.query<{ provider: string | null }>(`SELECT signature_provider AS provider FROM contracts WHERE id = $1 AND deleted_at IS NULL`, [contractId]),
    );
    if (!found.rows[0]) throw new NotFoundException("contract not found");
    return this.refresh(tenantId, contractId, found.rows[0].provider);
  }

  private async refresh(tenantId: string, contractId: string, provider: string | null): Promise<CertifiedSigningRefreshed> {
    if (!provider) throw new ConflictException({ message: "this agreement has no signing envelope yet", reason: "no_envelope" });
    const account = signatureAccountNamed(provider);
    if (!account) noCertifiedProvider();
    const s = await syncEnvelope(account, tenantId, contractId);
    const st = await withTenants([tenantId], (c) => c.query<{ status: string }>(`SELECT status FROM contracts WHERE id = $1`, [contractId]));
    return { status: s.status, outcome: summarize(s), contractStatus: st.rows[0]?.status ?? null };
  }
}
