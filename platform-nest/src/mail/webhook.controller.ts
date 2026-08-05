// MAIL-04 — `POST /api/mail/webhooks/brevo` (design §7.7). Provider delivery/bounce events. Root
// path (not `/api/:tenantId/...` — this is a global-table concern per §6.1, and the caller is an
// external provider, not a session), and deliberately NOT behind `AuthGuard`: the ONLY wall is the
// shared token header, same shape as search's `assertCallbackSecret` (constant-time compare,
// fail-closed when unconfigured — an unset `MAIL_WEBHOOK_TOKEN` refuses EVERY request, never
// skips the check).
//
// In the dev stage (v3) this receives NOTHING — there is no Brevo, sends never leave the box, and
// rows honestly cap at `sent`/`provider_accepted_at` (design §7.7's dev note). This handler still
// exists for real so its own logic (auth, idempotency, unknown-shape handling) is testable now and
// ready the moment §15 R3 wires a real Brevo webhook at staging.
import { Body, Controller, HttpCode, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { secretEquals } from "../core/secret-box";
import { withGlobal } from "../db";
import { addSuppression } from "./suppressions";
import { recordWebhookUnknown } from "./metrics";

const WEBHOOK_TOKEN_HEADER = "x-gaiada-mail-webhook-token";

/** Loose on purpose — the real Brevo shape is a staging-verify item (§15 R3: "real payload shapes
 *  match the recorded-shape corpus"); this is a reasonable superset of Brevo's documented
 *  transactional-webhook fields, not a contract with a live provider. */
interface BrevoDeliveryEvent {
  event?: string;
  "message-id"?: string;
  messageId?: string;
}

function assertWebhookToken(req: FastifyRequest): void {
  const configured = config.mail.webhookToken;
  const raw = req.headers[WEBHOOK_TOKEN_HEADER];
  const presented = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  if (!configured || !secretEquals(presented, configured)) {
    throw new UnauthorizedException("invalid or missing mail webhook token");
  }
}

// hard_bounce/blocked -> bounced + suppression; complaint -> suppression only; soft_bounce -> log
// only (design §7.7). Anything else (including a missing event/messageId) is logged + 204 —
// "never a 5xx a provider retry loop into existence" per the same section.
const TERMINAL_BOUNCE_EVENTS = new Set(["hard_bounce", "blocked"]);

@Controller("api/mail")
export class MailWebhookController {
  @Post("webhooks/brevo")
  @HttpCode(204)
  async brevoDeliveryWebhook(
    @Req() req: FastifyRequest,
    @Body() body: BrevoDeliveryEvent | BrevoDeliveryEvent[] | undefined,
  ): Promise<void> {
    assertWebhookToken(req);
    const events = Array.isArray(body) ? body : body ? [body] : [];
    for (const evt of events) {
      // eslint-disable-next-line no-await-in-loop
      await this.applyOne(evt);
    }
  }

  private async applyOne(evt: BrevoDeliveryEvent): Promise<void> {
    const messageId = evt?.["message-id"] ?? evt?.messageId;
    const eventName = evt?.event;
    if (!messageId || !eventName) {
      recordWebhookUnknown();
      return;
    }
    await withGlobal(async (c) => {
      const { rows } = await c.query<{ id: string; to_email: string }>(
        `SELECT id, to_email FROM mail_log WHERE provider_message_id = $1 LIMIT 1`,
        [messageId],
      );
      const row = rows[0];
      if (!row) {
        // Design A9-adjacent: unknown reference -> count + 204, never an error the provider retries
        // forever over. This is the delivery-event webhook, not the inbound-reply one (that's A9
        // itself, MAIL-13) — kept as a distinct counter so the two are never conflated in a dashboard.
        recordWebhookUnknown();
        return;
      }
      if (eventName === "delivered") {
        // `AND status <> 'delivered'` makes a replayed identical event a true no-op (0 rows
        // touched) rather than merely re-writing the same terminal state with a fresh timestamp —
        // the literal reading of "idempotent".
        await c.query(
          `UPDATE mail_log SET status = 'delivered', delivered_at = now(), updated_at = now()
             WHERE id = $1 AND status <> 'delivered'`,
          [row.id],
        );
      } else if (TERMINAL_BOUNCE_EVENTS.has(eventName)) {
        await c.query(
          `UPDATE mail_log SET status = 'bounced', updated_at = now() WHERE id = $1 AND status <> 'bounced'`,
          [row.id],
        );
        // ON CONFLICT (email, stream) DO NOTHING inside addSuppression — a repeat bounce for the
        // same address never produces a second suppression row.
        await addSuppression(c, row.to_email, "*", "hard_bounce", { provider: "brevo", detail: eventName });
      } else if (eventName === "complaint") {
        await addSuppression(c, row.to_email, "*", "complaint", { provider: "brevo" });
      } else if (eventName === "soft_bounce") {
        await c.query(
          `UPDATE mail_log SET last_error = $2, updated_at = now() WHERE id = $1 AND (last_error IS DISTINCT FROM $2)`,
          [row.id, "soft_bounce"],
        );
      } else {
        recordWebhookUnknown();
      }
    });
  }
}
