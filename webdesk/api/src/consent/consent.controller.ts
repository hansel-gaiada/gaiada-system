// M5-G6 — the public consent log endpoint. The gaiada.com banner posts here on EVERY decision (grant, update,
// withdraw), so the site can prove what a visitor chose and when. Contract:
//
//   POST    /v1/t/:tenantSlug/consent   body {consentId?, analytics, marketing, version, action?}  ->  201 {consentId}
//   OPTIONS /v1/t/:tenantSlug/consent   CORS preflight (204)
//
// Public and unauthenticated like the forms route: per-tenant Origin allowlist (403), Redis rate limit that
// fails closed (429 / 503), a 2 KiB body cap (413), a strict allow-list (unknown keys dropped, bad types 400).
// No cookies are set; no IP and no raw User-Agent are stored (only a coarse class). The response carries the
// consent id the browser must keep and send with every later decision and with form submissions
// (visitor_consent.consentId).
import { Body, Controller, HttpCode, Logger, Options, PayloadTooLargeException, BadRequestException, Post, Req, UseGuards } from "@nestjs/common";
import { ConsentContextGuard } from "./consent-context.guard";
import { ConsentRateLimitGuard } from "./consent-rate-limit.guard";
import { ConsentRepository } from "./consent.repository";
import { classifyUserAgent, parseConsentBody } from "./consent-body";
import { consentConfig } from "./consent.config";
import type { WebdeskConsentRequest } from "./consent-request";

@Controller("v1/t/:tenantSlug/consent")
export class ConsentController {
  private readonly logger = new Logger(ConsentController.name);

  constructor(private readonly repo: ConsentRepository) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ConsentContextGuard, ConsentRateLimitGuard)
  async record(@Req() req: WebdeskConsentRequest, @Body() body: unknown): Promise<{ consentId: string }> {
    const ctx = req.webdeskConsent!; // set by ConsentContextGuard

    if (Buffer.byteLength(JSON.stringify(body ?? null), "utf8") > consentConfig.maxBodyBytes) {
      throw new PayloadTooLargeException(`consent body exceeds ${consentConfig.maxBodyBytes} bytes`);
    }
    const parsed = parseConsentBody(body);
    if (!parsed.ok) throw new BadRequestException(parsed.reason);
    const c = parsed.value;

    await this.repo.insert({
      consentId: c.consentId,
      tenantId: ctx.tenantId,
      siteId: ctx.siteId,
      analytics: c.analytics,
      marketing: c.marketing,
      noticeVersion: c.version,
      action: c.action,
      userAgentClass: classifyUserAgent(req.headers?.["user-agent"]),
    });

    // Counts only: never the consent id, never a value from the body.
    if (c.droppedKeys > 0 || c.minted) {
      this.logger.log(`consent: tenant ${ctx.tenantId} action=${c.action} dropped_keys=${c.droppedKeys} id_minted=${c.minted}`);
    }
    return { consentId: c.consentId };
  }

  @Options()
  @HttpCode(204)
  @UseGuards(ConsentContextGuard)
  preflight(): void {
    // The guard set the Access-Control-Allow-* headers (or refused a disallowed origin with 403).
  }
}
