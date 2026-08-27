// WSK-25 — the authorization check for this module's 3 routes, deliberately NOT
// ../control/policy/command-authorization.guard.ts reused directly: that guard's `@Command(name)`
// decorator is typed against ../control/command-types.ts's closed `CommandName` union, and this
// ticket's own scope note says to stay out of that shared file. A plain function (not a second
// generic decorator-driven guard class) is the honest minimum here — there are exactly three
// routes, their requirements are fixed and known at the call site, and this still enforces the
// SAME design-table rule WSK-21/22 enforce for every other command: design §07 — "Promote to live
// / rollback: always WS4, every principal class" (blueprint C-05 rule); `content.export` is read,
// no WS4.
//
// This runs AFTER ControlAuthGuard (../control/auth/control-auth.guard.ts, already exported by
// ControlModule and reused here unmodified — see promotion.module.ts) has resolved
// `request.control` — real mTLS+Keycloak+WS4 in every environment except NODE_ENV=test, where the
// dev-mode stub reads plain headers (same convention every other control-plane route in this
// codebase uses, e.g. schema-draft.controller.ts).
import { ForbiddenException } from "@nestjs/common";
import type { ControlContext } from "../control/auth/control-request";
import type { ControlScope } from "../control/command-types";

export type PromotionCommandName = "content.export" | "content.promote" | "content.rollback";

const REQUIREMENT: Readonly<Record<PromotionCommandName, { scope: ControlScope; requireWs4: boolean }>> = Object.freeze({
  "content.export": { scope: "webdesk:read", requireWs4: false },
  "content.promote": { scope: "webdesk:promote", requireWs4: true },
  "content.rollback": { scope: "webdesk:promote", requireWs4: true },
});

/** Throws ForbiddenException with a distinct, named reason for every refusal — never a bare 403. */
export function assertPromotionCommandAuthorized(ctx: ControlContext, command: PromotionCommandName): void {
  const requirement = REQUIREMENT[command];
  if (!ctx.principal.scopes.includes(requirement.scope)) {
    throw new ForbiddenException(
      `command '${command}' requires scope '${requirement.scope}' — principal '${ctx.principal.subject}' has [${ctx.principal.scopes.join(", ")}]`,
    );
  }
  if (requirement.requireWs4 && !ctx.ws4ApprovalId) {
    throw new ForbiddenException(
      `command '${command}' is HIGH-impact and always requires a WS4 assertion (design §03 Layer 4 / §07 "Promote to live / rollback: always WS4") — none was presented`,
    );
  }
}
