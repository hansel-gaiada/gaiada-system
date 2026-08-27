// Must run AFTER ControlAuthGuard (needs `request.control`). Reads the route's `@Command(...)`
// metadata, looks up its full impact-class/scope entry in COMMAND_REGISTRY (never trusts a
// per-route literal — one registry, one source of truth, checkable by
// test/control-command-registry.spec.ts), and asks the PolicyDecisionPoint seam to decide.
//
// WSK-22 — also reads the raw `x-ws4-assertion` header directly off the request (never through
// `request.control`, which only ever carries the UNVERIFIED convenience approvalId — see
// real-control-channel-authenticator.ts's comment) plus route params + body, and passes both to
// the PDP as `ws4AssertionHeader`/`args`. This guard does no crypto itself — RealPolicyDecisionPoint
// owns Layer 4's actual verification; this file's only job is handing it the raw material.
import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { COMMAND_META_KEY } from "../command.decorator";
import { COMMAND_REGISTRY, type CommandName } from "../command-types";
import { POLICY_DECISION_POINT, type PolicyDecisionPoint } from "./policy-decision-point";
import { requireControlContext, type ControlRequest } from "../auth/control-request";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class CommandAuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_DECISION_POINT) private readonly pdp: PolicyDecisionPoint,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const commandName = this.reflector.get<CommandName | undefined>(COMMAND_META_KEY, context.getHandler());
    if (!commandName) {
      // A missing @Command() is a wiring bug, not a caller error — fail loud rather than let an
      // unclassified route through ungated.
      throw new InternalServerErrorException("route is missing @Command(...) — every control-plane route must declare one");
    }
    const meta = COMMAND_REGISTRY[commandName];

    const request = context.switchToHttp().getRequest<ControlRequest>();
    const { principal, ws4ApprovalId } = requireControlContext(request);

    const tenantSlug = (request.params as Record<string, string> | undefined)?.tenantSlug ?? null;
    const ws4AssertionHeader = firstHeader(request.headers["x-ws4-assertion"]);
    const args: Record<string, unknown> = {
      ...(request.params as Record<string, unknown> | undefined),
      ...((request.body as Record<string, unknown> | null | undefined) ?? {}),
    };
    const decision = await this.pdp.evaluate({ principal, meta, tenantSlug, ws4ApprovalId, ws4AssertionHeader, args });
    if (!decision.allow) {
      throw new ForbiddenException(decision.reason ?? `command '${commandName}' refused`);
    }
    return true;
  }
}
