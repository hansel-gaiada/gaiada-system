// M5-G6 — two Redis fixed-window counters on the public consent endpoint, per client IP and per tenant, using the
// forms limiter (forms/form-rate-limit.service.ts) under their own key scopes so the budgets never mix. FAIL
// CLOSED: an unreachable Redis refuses the request (503) rather than admitting unlimited traffic. Runs after
// ConsentContextGuard (a wrong origin 403s before a bucket is touched).
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { FormRateLimitService } from "../forms/form-rate-limit.service";
import { consentConfig } from "./consent.config";
import type { WebdeskConsentRequest } from "./consent-request";

@Injectable()
export class ConsentRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: FormRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskConsentRequest>();
    const reply = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>();
    const ctx = request.webdeskConsent;
    if (!ctx) throw new HttpException("no resolved consent context for rate-limit check", HttpStatus.INTERNAL_SERVER_ERROR);

    let ipDecision, tenantDecision;
    try {
      // The socket address only (never a client-settable header), as the forms guard does.
      [ipDecision, tenantDecision] = await Promise.all([
        this.limiter.consume("consent-ip", request.ip || "unknown", consentConfig.ipLimitPerWindow, consentConfig.ipWindowMs),
        this.limiter.consume("consent-tenant", ctx.tenantId, consentConfig.tenantLimitPerWindow, consentConfig.tenantWindowMs),
      ]);
    } catch (err) {
      throw new ServiceUnavailableException(`rate limiter unavailable: ${String(err)}`);
    }

    if (typeof reply?.header === "function") {
      reply.header("X-RateLimit-Limit-IP", String(ipDecision.limit));
      reply.header("X-RateLimit-Remaining-IP", String(ipDecision.remaining));
    }
    if (!ipDecision.allowed || !tenantDecision.allowed) {
      throw new HttpException({ error: "rate limit exceeded", scope: !ipDecision.allowed ? "ip" : "tenant" }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
