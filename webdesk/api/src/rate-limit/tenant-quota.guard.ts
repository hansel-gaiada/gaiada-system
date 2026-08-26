import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { TenantQuotaService } from "./tenant-quota.service";
import type { WebdeskRequest } from "../auth/webdesk-request";

/**
 * Must run AFTER ApiKeyAuthGuard (needs `request.webdesk.tenantId`) — apply it in @UseGuards in
 * that order. Refuses with 429, never silently drops the request into an unbounded queue.
 */
@Injectable()
export class TenantQuotaGuard implements CanActivate {
  constructor(private readonly quota: TenantQuotaService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WebdeskRequest>();
    const tenantId = request.webdesk?.tenantId;
    if (!tenantId) {
      // No resolved tenant means ApiKeyAuthGuard did not run (or was skipped) ahead of this
      // guard — a wiring mistake, not something to paper over by letting the request through.
      throw new HttpException("no resolved tenant for quota check", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const decision = this.quota.consume(tenantId);
    const reply = context.switchToHttp().getResponse();
    if (typeof reply?.header === "function") {
      reply.header("X-RateLimit-Limit", String(decision.limit));
      reply.header("X-RateLimit-Remaining", String(decision.remaining));
      reply.header("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
    }

    if (!decision.allowed) {
      throw new HttpException(
        { error: "tenant read quota exceeded", resetAt: decision.resetAt },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
