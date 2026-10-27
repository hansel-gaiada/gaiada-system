// WSK-41 — Layer 2e: the editorial principal (write-plane design §3.3 / §5). Must run AFTER
// ControlAuthGuard and CommandAuthorizationGuard:
//
//   @UseGuards(ControlAuthGuard, CommandAuthorizationGuard, EditorialAssertionGuard)
//
// so the cheaper refusals (L1-L4) happen first and never reach the resolver (WSK-40's resolver
// consumes a single-use `jti`; a request that L3 was going to refuse must not burn one). Validation
// of the body happens in the handler, after every guard, so a denial is never pre-empted by a 400/422.
//
// The guard does no crypto. It hands the resolver bound to EDITORIAL_PRINCIPAL_RESOLVER the
// command and the SAME argument object CommandAuthorizationGuard hashes for WS4 (route params merged
// with the body), and puts the resolved principal on `request.editorial`.
import { CanActivate, ExecutionContext, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { COMMAND_META_KEY } from "../command.decorator";
import { EDITORIAL_COMMANDS, type CommandName } from "../command-types";
import { EDITORIAL_PRINCIPAL_RESOLVER, type EditorialPrincipalResolver, type EditorialRequest } from "./editorial-principal";
import { assertClientMayRun } from "./client-editor";
import { assertContributorMayRun } from "./contributor-editor";

@Injectable()
export class EditorialAssertionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(EDITORIAL_PRINCIPAL_RESOLVER) private readonly resolver: EditorialPrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const command = this.reflector.get<CommandName | undefined>(COMMAND_META_KEY, context.getHandler());
    if (!command || !EDITORIAL_COMMANDS.has(command)) {
      // A wiring bug: this guard only belongs on the editorial commands. Fail loud.
      throw new InternalServerErrorException(
        `EditorialAssertionGuard is bound to a route whose command (${String(command)}) is not an editorial command`,
      );
    }
    const request = context.switchToHttp().getRequest<EditorialRequest>();
    const args: Record<string, unknown> = {
      ...(request.params as Record<string, unknown> | undefined),
      ...((request.body as Record<string, unknown> | null | undefined) ?? {}),
    };
    request.editorial = await this.resolver.resolve(request, command, args);
    // WSK-49b: a client principal (`ce: true`) may run only the allow-listed commands; refused here, before
    // any body validation or state is looked at. A no-op for every other principal.
    assertClientMayRun(request.editorial, command);
    // M5-W1e: a contributor principal (`xc: true`) may run only CONTRIBUTOR_COMMANDS, refused here for the same reason.
    assertContributorMayRun(request.editorial, command);
    return true;
  }
}
