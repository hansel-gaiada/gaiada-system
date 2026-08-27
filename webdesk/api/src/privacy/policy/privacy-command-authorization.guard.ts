// WSK-38 — structurally identical to ../../control/policy/command-authorization.guard.ts, reading
// PRIVACY_COMMAND_REGISTRY instead of COMMAND_REGISTRY. Must run AFTER ControlAuthGuard (needs
// `request.control`) — see privacy.module.ts for the exact guard order every route uses.
//
// Delegates the actual Layer-3 (scope) / Layer-4 (WS4 assertion) decision to the SAME
// `PolicyDecisionPoint` interface control/** already defines (control/policy/policy-decision-point.ts,
// imported type-only) and the SAME `RealPolicyDecisionPoint`/`DevModePolicyDecisionPoint`
// implementations (imported as classes and RE-PROVIDED under this module's own DI graph in
// privacy.module.ts — see that file's header for why a second binding of the same classes is safe
// and necessary rather than a `control/**` edit). The one seam this file cannot avoid: `evaluate()`
// is typed to take `meta: CommandMeta`, whose `command` field is `control/command-types.ts`'s own
// `CommandName` union — `PrivacyCommandMeta.command` is a DIFFERENT, disjoint string-literal union
// (`PrivacyCommandName`), so passing one where the other is expected needs an explicit cast. This
// is safe because `PolicyDecisionPoint.evaluate` only ever reads `meta.command`/`meta.scope`/
// `meta.impactClass` structurally (a plain string/enum read, never a `CommandName`-specific
// branch) — verified by reading both concrete implementations before relying on this. Flagged
// loudly, not hidden, because a cast is exactly the kind of thing a future reader should not have
// to rediscover by tracing types themselves.
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PRIVACY_COMMAND_META_KEY } from "../command.decorator";
import { PRIVACY_COMMAND_REGISTRY, type PrivacyCommandName } from "../command-types";
import { POLICY_DECISION_POINT, type PolicyDecisionPoint, type PolicyDecisionInput } from "../../control/policy/policy-decision-point";
import type { CommandMeta } from "../../control/command-types";
import { requireControlContext, type ControlRequest } from "../../control/auth/control-request";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class PrivacyCommandAuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_DECISION_POINT) private readonly pdp: PolicyDecisionPoint,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const commandName = this.reflector.get<PrivacyCommandName | undefined>(PRIVACY_COMMAND_META_KEY, context.getHandler());
    if (!commandName) {
      throw new InternalServerErrorException("route is missing @PrivacyCommand(...) — every privacy route must declare one");
    }
    const meta = PRIVACY_COMMAND_REGISTRY[commandName];

    const request = context.switchToHttp().getRequest<ControlRequest>();
    const { principal, ws4ApprovalId } = requireControlContext(request);

    const tenantSlug = (request.params as Record<string, string> | undefined)?.tenantSlug ?? null;
    const ws4AssertionHeader = firstHeader(request.headers["x-ws4-assertion"]);
    const args: Record<string, unknown> = {
      ...(request.params as Record<string, unknown> | undefined),
      ...((request.body as Record<string, unknown> | null | undefined) ?? {}),
    };
    const input: PolicyDecisionInput = {
      principal,
      // See this file's header — safe structurally, unsafe nominally; the cast is the documented
      // seam, not an oversight.
      meta: meta as unknown as CommandMeta,
      tenantSlug,
      ws4ApprovalId,
      ws4AssertionHeader,
      args,
    };
    const decision = await this.pdp.evaluate(input);
    if (!decision.allow) {
      throw new ForbiddenException(decision.reason ?? `command '${commandName}' refused`);
    }
    return true;
  }
}
