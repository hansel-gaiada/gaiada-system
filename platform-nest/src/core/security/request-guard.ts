// DW-7h (FRONTEND-BFF-CONTRACT §52.3 to §52.5; PERMISSION-CONTRACT §42) — the ONE place an authenticated request is
// checked against IT's security controls, in this order:
//
//   1. a session IT signed out, or a token from before IT blocked the login  -> 401 `session_revoked`  (§52.4)
//   2. on a `:tenantId` route, an address IT blocked for that company       -> 403 `ip_blocked`       (§52.5)
//   3. on a `:tenantId` route with a resolved user, record the connection   -> `security_access_seen` (§52.3)
//
// Called by the AuthGuard (auth/guards.ts) right after it has resolved the principal, on every credential path, so a
// route is covered because it is authenticated, not because someone remembered a decorator. Public routes and
// webhooks have no AuthGuard and never reach this.
//
// These refusals are NOT authorization decisions (PERMISSION-CONTRACT §42): they run before Cerbos, do not audit as
// decisions, and the refused request is not recorded as a connection. A lookup that fails throws, so the request
// fails rather than slipping past a control it could not check.
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { Principal } from "../../rbac/principal";
import { isTenantIdShaped, TENANT_PARAM } from "../tenant-param";
import { clientContextOf } from "./client-context";
import { createSessionCutoff, type SessionCutoff } from "./session-cutoff";
import { createIpBlockGuard, type IpBlockGuard } from "./ip-blocks";
import { createAccessRecorder, type AccessRecorder } from "./access-recorder";

export const SESSION_REVOKED_MESSAGE = "Your session was ended by IT. Sign in again.";
export const IP_BLOCKED_MESSAGE = "Access from this network address is blocked for this company.";

export interface RequestSecurity {
  sessionCutoff: SessionCutoff;
  ipBlocks: IpBlockGuard;
  recorder: AccessRecorder;
}

const createDefaults = (): RequestSecurity => ({
  sessionCutoff: createSessionCutoff(),
  ipBlocks: createIpBlockGuard(),
  recorder: createAccessRecorder(),
});

let defaults: RequestSecurity = createDefaults();

/** Test seam: forget every cache and throttle, so a row a test just wrote takes effect at once instead of within
 *  10 seconds. */
export function resetRequestSecurityForTest(): void {
  defaults = createDefaults();
}

type GuardedRequest = Pick<FastifyRequest, "headers" | "ip" | "params"> & { principal: Principal };

export async function enforceRequestSecurity(req: GuardedRequest, sec: RequestSecurity = defaults): Promise<void> {
  const p = req.principal;

  // 1. §52.4. Only the OIDC bearer path carries a `sid` and an `iat`; the service-token paths (dev x-user-id, OBO
  //    envelope) carry neither, so neither rule can match them and no lookup is made.
  if (p.userId && (await sec.sessionCutoff.isRevoked({ userId: p.userId, sessionId: p.sessionId, tokenIssuedAt: p.tokenIssuedAt }))) {
    throw new UnauthorizedException({ message: SESSION_REVOKED_MESSAGE, reason: "session_revoked" });
  }

  const tenantId = (req.params as Record<string, unknown> | undefined)?.[TENANT_PARAM];
  // The tenant-param hook has already refused a malformed id with 400; the shape check stays so a uuid cast below can
  // never see one, whatever runs first.
  if (!isTenantIdShaped(tenantId)) return;
  const client = clientContextOf(req);

  // 2. §52.5. A null address is never blocked (blockFor says null).
  const blockId = await sec.ipBlocks.blockFor(tenantId, client.ip);
  if (blockId) {
    sec.ipBlocks.countHit(tenantId, blockId);
    throw new ForbiddenException({ message: IP_BLOCKED_MESSAGE, reason: "ip_blocked" });
  }

  // 3. §52.3. Fire and forget.
  if (p.userId) {
    sec.recorder.record({
      tenantId,
      userId: p.userId,
      sessionId: p.sessionId ?? "",
      ip: client.ip,
      userAgent: client.userAgent,
    });
  }
}
