// WSK-05 — the scoped-auth middleware the ticket asks for: "resolves the key -> tenant + env +
// scope, then runs the request inside the tenant GUC context. Fail closed."
//
// Ordering requirement for every route this guards: it must run BEFORE ScopeGuard and
// TenantQuotaGuard (both read `request.webdesk`, which only this guard sets), and it must be the
// LAST thing NestJS does before entering the controller method — which is exactly what a
// `CanActivate` returning `true` already guarantees (Nest's Fastify adapter runs guards,
// interceptors, then the handler as one continuously-awaited chain for a given request; see
// db/tenant-context.ts's header on `enterTenantContext`).
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { enterTenantContext } from "../db/tenant-context";
import type { WebdeskRequest } from "./webdesk-request";

function extractBearerKey(request: WebdeskRequest): string | null {
  const header = request.headers?.authorization;
  if (!header || typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService, private readonly tenants: TenantLookupService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskRequest>();
    const params = (request.params ?? {}) as Record<string, string>;
    const tenantSlug = params.tenantSlug;

    // No route param, no route match, no request — every branch below refuses; nothing here can
    // fall through to "allowed" without every one of the checks below explicitly passing.
    if (!tenantSlug) {
      throw new UnauthorizedException("no tenant in route");
    }

    const plaintextKey = extractBearerKey(request);
    if (!plaintextKey) {
      // The no-key probe (ticket AC): missing/malformed Authorization header refuses, full stop.
      throw new UnauthorizedException("missing api key");
    }

    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") {
      // Deliberately the SAME exception/message shape as "unknown key" below — a probe should
      // not be able to tell "this tenant slug doesn't exist" apart from "this key is wrong for
      // an existing tenant" from the response alone.
      throw new UnauthorizedException("invalid credentials");
    }

    // resolve() re-reads api_keys fresh on every single call — no cache anywhere in this path,
    // which is what makes a revoke die on the very next request (ticket AC).
    const resolved = await this.apiKeys.resolve(tenant.id, plaintextKey);
    if (!resolved) {
      throw new UnauthorizedException("invalid credentials");
    }

    request.webdesk = resolved;
    enterTenantContext(resolved.tenantId);
    return true;
  }
}
