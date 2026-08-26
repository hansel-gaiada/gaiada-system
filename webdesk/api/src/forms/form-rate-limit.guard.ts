// WSK-10 — enforces BOTH counters (§11 AC: "per-IP and per-form rate limits"). Runs AFTER
// FormContextGuard (needs `request.webdeskForm.formId` — the resolved form's real id, not the raw
// route param, so a form-id-guessing probe against many DIFFERENT unresolved ids does not each get
// its own fresh budget by construction... though in practice FormContextGuard's own 404 already
// stops that path before this guard is even reached; ordering is documented in forms.module.ts).
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { FormRateLimitService } from "./form-rate-limit.service";
import { formsConfig } from "./forms.config";
import type { WebdeskFormRequest } from "./forms-request";

function clientIp(request: WebdeskFormRequest): string {
  // Fastify's own `request.ip` (raw socket address unless `trustProxy` is configured in
  // main.ts/app.ts — out of this ticket's owned scope; see README.md's forms section for the
  // caveat this leaves for whoever wires the real reverse-proxy chain). Never derived from a
  // client-settable header directly (an `X-Forwarded-For` read here, without a trusted-proxy
  // configuration validating it, would let any caller pick their own rate-limit bucket).
  return request.ip || "unknown";
}

@Injectable()
export class FormRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: FormRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskFormRequest>();
    const reply = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>();
    const form = request.webdeskForm;
    if (!form) {
      // FormContextGuard must run first — see forms.module.ts's @UseGuards ordering comment.
      throw new HttpException("no resolved form for rate-limit check", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    let ipDecision, formDecision;
    try {
      [ipDecision, formDecision] = await Promise.all([
        this.limiter.consume("ip", clientIp(request), formsConfig.ipLimitPerWindow, formsConfig.ipWindowMs),
        this.limiter.consume("form", form.formId, formsConfig.formLimitPerWindow, formsConfig.formWindowMs),
      ]);
    } catch (err) {
      // Fail CLOSED (form-rate-limit.service.ts's header) — an unreachable limiter refuses rather
      // than silently admitting unlimited traffic.
      throw new ServiceUnavailableException(`rate limiter unavailable: ${String(err)}`);
    }

    if (typeof reply?.header === "function") {
      reply.header("X-RateLimit-Limit-IP", String(ipDecision.limit));
      reply.header("X-RateLimit-Remaining-IP", String(ipDecision.remaining));
      reply.header("X-RateLimit-Limit-Form", String(formDecision.limit));
      reply.header("X-RateLimit-Remaining-Form", String(formDecision.remaining));
    }

    if (!ipDecision.allowed || !formDecision.allowed) {
      throw new HttpException(
        { error: "rate limit exceeded", scope: !ipDecision.allowed ? "ip" : "form" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
