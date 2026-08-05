// MAIL-13 — `POST /api/mail/inbound/brevo` (design §7.6). The internet-facing untrusted-input door.
//
// Same posture as MAIL-04's delivery-event webhook and for the same reasons: root path (not
// `/api/:tenantId/...` — the caller is a provider, not a session, and `mail_messages` is a global
// table per §6.1), deliberately NOT behind `AuthGuard`, and the ONLY walls are the shared token
// (fail-closed when unset) plus the optional HMAC signature — both in `inbound/auth.ts`.
//
// STATUS CODES, and why each one:
//   401  bad/absent token, or a required signature that failed. The only 4xx an unauthenticated
//        caller can distinguish, and it says nothing about whether any token exists.
//   413  the delivery exceeded `MAIL_INBOUND_MAX_BYTES`. Authenticated callers only — the cap
//        behaviour is not observable to a stranger.
//   429  per-source rate limit.
//   400  the authenticated body was not a parseable Brevo envelope. Counted as `malformed`.
//   204  EVERYTHING ELSE, including: threaded, replayed (idempotent no-op), classified NDR, and the
//        A9 drop (no token / unknown token). A9 is binding here — an unmatched token must be
//        indistinguishable from a matched one to the sender, and must never become an error a
//        provider retries forever over (§7.7).
import { Controller, HttpCode, HttpException, HttpStatus, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { authenticateInbound } from "./inbound/auth";
import { MalformedInboundPayloadError, parseBrevoInbound } from "./inbound/brevo-payload";
import { ingestInbound } from "./inbound/intake";
import { checkInboundRate } from "./inbound/rate-limit";
import { takeCapturedRawBody } from "./inbound/raw-body";
import { recordInbound, recordInboundRejected } from "./metrics";

/** Response body is deliberately EMPTY on every success path (204). A body saying "threaded" vs
 *  "unmatched" would hand an attacker a token oracle — the exact thing A9 exists to prevent. */
@Controller("api/mail")
export class MailInboundController {
  @Post("inbound/brevo")
  @HttpCode(204)
  async brevoInbound(@Req() req: FastifyRequest): Promise<void> {
    const captured = takeCapturedRawBody(req);
    if (!captured) {
      // The `preParsing` hook is registered in buildApp() for exactly this URL prefix. Its absence
      // means the app was assembled without it — a wiring bug, not an untrusted-input condition, and
      // it must fail CLOSED rather than fall back to verifying a signature over a re-serialization.
      recordInboundRejected("auth");
      recordInbound("brevo-inbound", "rejected");
      throw new UnauthorizedException("inbound raw-body capture not installed");
    }

    const auth = authenticateInbound(req.headers as Record<string, unknown>, captured.raw);
    if (!auth.ok) {
      recordInboundRejected("auth");
      recordInbound("brevo-inbound", "rejected");
      throw new UnauthorizedException(auth.reason);
    }

    // Rate limit AFTER authentication: an unauthenticated flood already costs only a constant-time
    // compare, and keying the limiter on authenticated traffic keeps a spoofed-IP flood from
    // exhausting a legitimate provider's window.
    const source = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || "unknown";
    const rate = checkInboundRate(source, config.mail.inboundRatePerMin);
    if (!rate.allowed) {
      recordInboundRejected("rate");
      recordInbound("brevo-inbound", "rejected");
      throw new HttpException(`inbound rate limit exceeded (${rate.limit}/min)`, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (captured.overCap) {
      recordInboundRejected("size");
      recordInbound("brevo-inbound", "rejected");
      throw new HttpException(
        `inbound message exceeds MAIL_INBOUND_MAX_BYTES (${config.mail.inboundMaxBytes})`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    let items;
    try {
      items = parseBrevoInbound(JSON.parse(captured.raw.toString("utf8")) as unknown, captured.receivedBytes);
    } catch (err) {
      recordInboundRejected("malformed");
      recordInbound("brevo-inbound", "rejected");
      const detail = err instanceof MalformedInboundPayloadError ? err.message : "body is not valid JSON";
      throw new HttpException(`malformed inbound payload: ${detail}`, HttpStatus.BAD_REQUEST);
    }

    for (const item of items) {
      // Sequential on purpose: one delivery carries one item in practice, and a hostile 500-item
      // envelope must not fan out 500 concurrent scans + writes. Each item is independent, so one
      // item's outcome never affects another's — and `ingestInbound` never throws for untrusted-input
      // reasons, so there is no partial-failure story to unwind.
      // eslint-disable-next-line no-await-in-loop
      await ingestInbound(item);
    }
  }
}
