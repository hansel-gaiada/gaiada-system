// Auth guards (Nest port of server.ts serviceAuth + authenticate). Same two credential
// shapes and fail-closed semantics; guards populate request.principal and throw
// UnauthorizedException (401) instead of writing a Fastify reply.
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { assemblePrincipal, ANONYMOUS } from "../rbac/principal";
import { principalFromToken } from "./oidc";
import { withGlobal } from "../db";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearerOf(req: FastifyRequest): string {
  const h = req.headers.authorization ?? "";
  const s = Array.isArray(h) ? h[0] : h;
  return s?.startsWith("Bearer ") ? s.slice(7) : "";
}

/** Service-token-only routes (bot/hub): /principal/resolve, /identity/enroll/confirm, /dev/*. */
@Injectable()
export class ServiceGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!config.serviceToken || !safeEqual(bearerOf(req), config.serviceToken)) {
      throw new UnauthorizedException("unauthorized");
    }
    return true;
  }
}

/** Authenticated-user gate for /api + user-initiated routes. OIDC JWT, or service token +
 *  (x-user-id in dev | OBO envelope). Populates request.principal. */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const bearer = bearerOf(req);

    // OIDC user path — a valid IdP token authenticates the user directly.
    if (config.authMode === "oidc" && bearer && bearer !== config.serviceToken) {
      try {
        const principal = await principalFromToken(bearer);
        if (principal) {
          req.principal = principal;
          return true;
        }
        throw new UnauthorizedException("unknown or inactive user");
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        // not a JWT — fall through to service-credential paths
      }
    }

    // Everything below is a SERVICE call and must present the service token (fail-closed).
    if (!config.serviceToken || !safeEqual(bearer, config.serviceToken)) {
      throw new UnauthorizedException("unauthorized");
    }

    // Dev mode: the acting user is named by x-user-id (local + tests).
    const userId = req.headers["x-user-id"];
    if (config.authMode === "dev" && typeof userId === "string" && userId) {
      const principal = await assemblePrincipal(userId, "high");
      if (!principal) throw new UnauthorizedException("unknown or inactive user");
      req.principal = principal;
      return true;
    }

    // OBO envelope (D4): verified link → 'linked'; unverified/unknown → minimal principal.
    const provider = req.headers["x-obo-provider"];
    const externalId = req.headers["x-obo-external-id"];
    if (typeof provider === "string" && typeof externalId === "string" && provider && externalId) {
      const link = await withGlobal((c) =>
        c.query<{ user_id: string; verified_at: string | null }>(
          `SELECT user_id, verified_at FROM identity_links WHERE provider = $1 AND external_id = $2`,
          [provider, externalId],
        ),
      );
      const row = link.rows[0];
      if (row?.verified_at) {
        const principal = await assemblePrincipal(row.user_id, "linked");
        if (principal) {
          req.principal = principal;
          return true;
        }
      }
      req.principal = { ...ANONYMOUS };
      return true;
    }
    throw new UnauthorizedException("x-user-id or an OBO envelope required");
  }
}
