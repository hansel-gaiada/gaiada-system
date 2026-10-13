// PV5-10 — `POST /api/webhooks/payments/:provider`: the payment provider's notification URL (for Midtrans, the
// dashboard's "Payment Notification URL" = https://erp.gaiada.com/api/webhooks/payments/midtrans). nginx already routes
// `/api/webhooks/` on the ERP host to platform-nest (infra/nginx/erp.gaiada.online.conf).
//
// ── THE SIGNATURE IS THE ENTIRE AUTHENTICATION WALL (the GitHub receiver's shape) ───────────────────────
// Internet-facing, no AuthGuard, no Cerbos `authorize()`: the provider is not a session holder. The adapter verifies the
// notice's signature with the server key (Midtrans: hex SHA-512 of order_id + status_code + gross_amount + server key,
// constant-time) and a notice that fails it is 401 with NOTHING written. A provider that is unknown or switched off is
// 404 (it does not exist here), also with nothing written.
//
// ── VERIFY, CLAIM, ANSWER: FAST ─────────────────────────────────────────────────────────────────────────
// Midtrans wants a 200 within 5 seconds and retries for hours otherwise. So this handler does three things and returns:
//   1. verify (above);
//   2. claim the dedupe key: `INSERT INTO provider_events ... ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
//      atomic, and in the SAME transaction emit `payment.notice.received` to the outbox (process.ts). A conflict means
//      "already seen": 200 `{duplicate: true}`, nothing reprocessed;
//   3. answer 200.
// The status re-fetch and the posting run AFTER the answer, from the outbox consumer and the retry sweep (process.ts).
// A processing failure therefore never reaches the provider as a 5xx: it is recorded on the claim row and retried by us
// (the dedupe key is spent, so the provider's own retry would be deduped anyway).
//
// ── TENANT RESOLUTION, WITH NO RLS LOOSENING ────────────────────────────────────────────────────────────
// provider_events is FORCE RLS with tenant_id NOT NULL (202610130400's header). The notice names no company, and an
// unscoped lookup of order_id -> payment_checkouts would need a policy hole. So, exactly like the GitHub receiver
// (config.githubRepoSync.tenantId), the company comes from SERVER CONFIGURATION: MIDTRANS_TENANT_ID, the company that
// owns the merchant account the server key belongs to. That is not a guess: the key that verified the signature IS that
// company's account, so a verified notice can only be about money paid into that company. The claim and all processing
// run inside withTenants([that company]); a checkout of any other company is invisible there and the notice is
// `ignored: unknown_checkout`. (Several merchant accounts, one per company, would mean one key per company and a
// per-company lookup: a configuration change, not a schema loosening.)
//
// ── NOT THE STAFF DECIDE ROUTE, NOT D14 (plan finding 14) ───────────────────────────────────────────────
// A gateway payment never calls `POST /:tenantId/invoice-payments/:paymentId/decide` and never files an approval. That
// route's maker/checker rule (recorder != confirmer) and D14's human approval exist to put a SECOND PERSON in front of
// money a person claimed. Here nobody claims anything: the payment is written only from the provider's own status API,
// re-fetched over TLS with our key (design decision 15), by the provider's automation principal (registry.ts). This
// bypass is deliberate and is the whole of PV-D9 ("a verified provider notice confirms the payment with no staff step").
//
// ── [UNVERIFIED until the sandbox drive] ────────────────────────────────────────────────────────────────
//   * the dedupe key `order_id:transaction_status:status_code` (midtrans.ts verifyNotice explains the choice);
//   * the exact notice field formats: gross_amount as a string like "150000.00", status_code as a string, the time
//     fields as "YYYY-MM-DD HH:MM:SS" (GMT+7), and the content type being application/json;
//   * how often Midtrans re-sends one notice, and whether it re-sends after our 200 at all.
import { Body, Controller, HttpCode, NotFoundException, Param, Post, UnauthorizedException } from "@nestjs/common";
import { withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { configuredProvider } from "./registry";
import { PAYMENT_NOTICE_EVENT, PROVIDER_EVENT_STREAM } from "./process";

export interface PaymentWebhookAck {
  ok: true;
  duplicate?: boolean;
}

@Controller("api/webhooks")
export class PaymentWebhookController {
  @Post("payments/:provider")
  @HttpCode(200)
  async receive(@Param("provider") providerKey: string, @Body() body: unknown): Promise<PaymentWebhookAck> {
    const gw = configuredProvider(String(providerKey ?? "").toLowerCase());
    // Unknown or switched off: this endpoint does not exist. Same answer for both, nothing written.
    if (!gw) throw new NotFoundException("no such payment provider");

    const v = gw.provider.verifyNotice(body);
    if (!v.ok) {
      // Never echo why in detail: "bad signature" vs "malformed" helps nobody but a forger.
      throw new UnauthorizedException("payment notice not verified");
    }

    const claimed = await withTenants([gw.tenantId], async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO provider_events (provider, event_id, kind, tenant_id, ref, notice, status, origin_site)
         VALUES ($1, $2, 'payment', $3, $4, $5::jsonb, 'received', $6)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [gw.provider.name, v.notice.eventKey, gw.tenantId, v.notice.ref, JSON.stringify(v.notice.summary), config.originSite],
      );
      const id = r.rows[0]?.id;
      if (id) {
        // Same transaction as the claim: a claim with no job, or a job with no claim, cannot exist.
        await emitEvent(c, gw.tenantId, PROVIDER_EVENT_STREAM, id, PAYMENT_NOTICE_EVENT, { provider: gw.provider.name });
      }
      return id ?? null;
    });
    return claimed ? { ok: true } : { ok: true, duplicate: true };
  }
}
