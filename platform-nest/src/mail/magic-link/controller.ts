// MAIL-10 — the two magic-link HTTP endpoints (design §9). Root-level (no `/api` prefix), same
// shape as identity.controller.ts's `/dev/user-by-email`: these are BFF-internal calls from
// platform-ui's server-side code, never reached directly by a browser, so `ServiceGuard`
// (Bearer PLATFORM_SERVICE_TOKEN) gates both — a browser cannot even present the credential these
// routes require, let alone the magic-link token itself.
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../../config";
import { ServiceGuard } from "../../auth/guards";
import { resolveClientIp } from "../client-ip";
import { requestMagicLink, consumeMagicLink, MagicLinkNotEnabledError, MagicLinkConsumeError } from "./service";

/** MAIL-24 (QA-MAIL-11 Finding 3) gated this behind a trusted-proxy allowlist: `req.headers` is
 *  caller-controlled and this app never sets Fastify's `trustProxy` (main.ts), so `req.ip` is
 *  ALWAYS the raw TCP peer, never itself header-influenced — but the OLD code trusted
 *  `x-forwarded-for` verbatim regardless of who that peer was, so 8 freshly-spoofed values
 *  against a limit of 3 all minted (zero protection; not remotely exploitable AT THE TIME only
 *  because `ServiceGuard` gates this route and no browser-facing form existed anywhere in
 *  platform-ui — but the whole point is it must not become exploitable the moment one is built).
 *
 *  MAIL-37 extracted the gate itself into `../client-ip.ts` so `inbound.controller.ts` — which had
 *  the identical un-gated bug and was never ported when MAIL-24 landed — shares this implementation
 *  rather than a second, drifted copy. `xffPosition: "leftmost"` because the ONLY entity that ever
 *  writes this header on this call path is platform-ui's own server-side code (a direct internal
 *  call, no intermediary appending to it) — see `../client-ip.ts`'s module comment for why
 *  `inbound.controller.ts` needs the opposite end of the header instead.
 *
 *  Meaningful per-end-user rate limiting still REQUIRES platform-ui's server action to forward
 *  the originating browser's IP in this header on its call to `/auth/magic-link` — but now ONLY
 *  when platform-ui's own outbound IP is enrolled in `config.mail.magicLinkTrustedProxies`.
 *  Unset (the default, "trust nothing") => every caller's header is ignored outright and the
 *  limiter keys on the socket address — the honest pre-existing trade-off (shared-IP callers
 *  share one bucket), not a new one. */
function clientIp(req: FastifyRequest): string {
  return resolveClientIp(req, { trustedProxies: config.mail.magicLinkTrustedProxies, xffPosition: "leftmost" });
}

@Controller()
export class MagicLinkController {
  @Post("auth/magic-link")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(ServiceGuard)
  async request(@Req() req: FastifyRequest, @Body() body: { email?: string }): Promise<{ ok: true }> {
    try {
      const result = await requestMagicLink({ email: body?.email ?? "", ip: clientIp(req) });
      if (result.status === "suppressed") {
        // Deliberately distinguishable — design §5.1's one documented exception to "identical for
        // existing vs unknown". Everything else about this handler stays generic on purpose.
        throw new ServiceUnavailableException("delivery unavailable — contact an admin");
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof MagicLinkNotEnabledError) throw new NotFoundException();
      throw err;
    }
  }

  @Post("auth/magic-link/consume")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ServiceGuard)
  async consume(@Req() req: FastifyRequest, @Body() body: { token?: string }): Promise<{ userId: string }> {
    try {
      const { userId } = await consumeMagicLink({ token: body?.token ?? "", ip: clientIp(req) });
      return { userId };
    } catch (err) {
      if (err instanceof MagicLinkNotEnabledError) throw new NotFoundException();
      // MagicLinkConsumeError is the ONE generic error for unknown/replayed/expired — mapped
      // straight through, never re-distinguished at this layer.
      if (err instanceof MagicLinkConsumeError) throw new UnprocessableEntityException(err.message);
      throw err;
    }
  }
}
