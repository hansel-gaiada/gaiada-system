// WSK-41 — the production binding until WSK-40 lands (see ../control.module.ts). Content writes need
// a verified editorial assertion (design §5); without the pinned JWKS and the replay store there is
// nothing to verify one against, so every content write is refused with 503
// editorial-keys-not-configured. It fails closed by construction: no header, no environment variable
// and no caller can make this resolver return a principal.
import { Injectable } from "@nestjs/common";
import type { CommandName } from "../command-types";
import type { ControlRequest } from "./control-request";
import type { EditorialPrincipal, EditorialPrincipalResolver } from "./editorial-principal";
import { ControlProblem } from "../content/content-problem";

@Injectable()
export class NotConfiguredEditorialPrincipalResolver implements EditorialPrincipalResolver {
  async resolve(_req: ControlRequest, _command: CommandName, _args: Record<string, unknown>): Promise<EditorialPrincipal> {
    throw new ControlProblem(
      503,
      "editorial-keys-not-configured",
      "Editorial keys not configured",
      "Content writes need a verified editorial assertion, and this instance has no editorial verification keys " +
        "configured yet (WSK-40). Nothing was written.",
    );
  }
}
