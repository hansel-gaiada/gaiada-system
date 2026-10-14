// PV5-11 — `POST /api/webhooks/signatures/:provider`: a certified-signature provider's notification URL. nginx already
// routes `/api/webhooks/` on the ERP host to platform-nest. Today the only provider is the SIMULATED PSrE (PV-D43), which
// calls this route over the loopback after each signature (src/signatures/simulated-psre.ts).
//
// ── A SHARED CREDENTIAL IS THE WHOLE AUTHENTICATION, SO NOTHING IN THE NOTICE IS BELIEVED ───────────────
// Internet-facing, no AuthGuard, no Cerbos: the provider is not a session holder. VIDA's webhook carries no HMAC, only
// Basic or OAuth2 credentials (blueprint §1.3), and the simulator copies that shape: the adapter compares the
// `Authorization` header with the shared credential in constant time, and a notice that fails it is 401 with NOTHING
// written. Because a credential proves only who SENT the notice, not what it says, the notice is used as a trigger and
// nothing more: processing re-fetches the envelope from the provider and writes only that (process.ts, certified-signing.ts).
// An unknown or switched-off provider is 404 (it does not exist here), also with nothing written.
//
// ── AUTHENTICATE, CLAIM, ANSWER ──────────────────────────────────────────────────────────────────────
//   1. authenticate (above);
//   2. find the company: our partner reference ("<tenant>:<contract>", VIDA's partnerTrxId) names it. That is a lookup
//      key only: the claim is filed inside withTenants([that company]) (provider_events is FORCE RLS, tenant NOT NULL), and
//      processing then requires the envelope to be a contract OF that company and the provider's re-fetched status to
//      name the same reference. A reference that names no live company is acknowledged and dropped (200, logged): with no
//      company there is nowhere to file it, and a provider retrying it forever helps nobody;
//   3. claim the dedupe key: `INSERT INTO provider_events ... ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
//      and in the SAME transaction emit `signature.notice.received` (process.ts). A conflict is a replay: 200
//      `{duplicate: true}`, nothing reprocessed;
//   4. answer 200. Processing happens after the answer (outbox consumer, retry sweep).
import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post, UnauthorizedException } from "@nestjs/common";
import { withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { PROVIDER_EVENT_STREAM } from "../payments/process";
import { signatureAccountNamed } from "./registry";
import { tenantOfPartnerRef } from "./certified-signing";
import { SIGNATURE_NOTICE_EVENT } from "./process";

export interface SignatureWebhookAck {
  ok: true;
  duplicate?: boolean;
  ignored?: string;
}

@Controller("api/webhooks")
export class SignatureWebhookController {
  @Post("signatures/:provider")
  @HttpCode(200)
  async receive(
    @Param("provider") providerKey: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<SignatureWebhookAck> {
    const account = signatureAccountNamed(String(providerKey ?? "").toLowerCase());
    if (!account) throw new NotFoundException("no such signature provider");

    const v = account.verifyNotice(authorization, body);
    // Never say why in detail: "bad credential" vs "malformed" helps nobody but a forger.
    if (!v.ok) throw new UnauthorizedException("signature notice not verified");

    const ref = tenantOfPartnerRef(v.notice.partnerRef);
    const live = ref
      ? (await withGlobal((c) => c.query(`SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [ref.tenantId]))).rows.length > 0
      : false;
    if (!ref || !live) {
      // eslint-disable-next-line no-console
      console.warn(`[signatures] ${account.name} notice ${v.notice.eventKey} names no company of ours (${v.notice.partnerRef}); acknowledged and dropped`);
      return { ok: true, ignored: "unknown_partner_ref" };
    }

    const claimed = await withTenants([ref.tenantId], async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO provider_events (provider, event_id, kind, tenant_id, ref, notice, status, origin_site)
         VALUES ($1, $2, 'signature', $3, $4, $5::jsonb, 'received', $6)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [account.name, v.notice.eventKey, ref.tenantId, v.notice.envelopeId, JSON.stringify(v.notice.summary), config.originSite],
      );
      const id = r.rows[0]?.id;
      // Same transaction as the claim: a claim with no job, or a job with no claim, cannot exist.
      if (id) await emitEvent(c, ref.tenantId, PROVIDER_EVENT_STREAM, id, SIGNATURE_NOTICE_EVENT, { provider: account.name });
      return id ?? null;
    });
    return claimed ? { ok: true } : { ok: true, duplicate: true };
  }
}
