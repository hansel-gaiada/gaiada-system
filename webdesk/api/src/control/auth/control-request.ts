import { UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { ControlPrincipal } from "./control-principal";

export type ControlContext = {
  principal: ControlPrincipal;
  /** Presence only, in dev mode — WSK-22 replaces this with real HMAC verify of {approvalId, commandHash, exp}. */
  ws4ApprovalId: string | null;
};

export type ControlRequest = FastifyRequest & { control?: ControlContext };

/**
 * Explicit runtime guard rather than a `req.control!` assertion, matching this codebase's own
 * convention (ContentController's `if (!req.webdesk) throw new UnauthorizedException()`) —
 * `ControlAuthGuard` sets `request.control` on every accepted request, but a handler should
 * never silently trust a type annotation over an actual check.
 */
export function requireControlContext(request: ControlRequest): ControlContext {
  if (!request.control) {
    throw new UnauthorizedException("no control-channel context resolved for this request");
  }
  return request.control;
}
