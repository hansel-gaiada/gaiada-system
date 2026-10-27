// WSK-41 — the editorial principal seam (write-plane design §3.3, §5, §12's WSK-41 signatures).
//
// What it is: "the ERP's Cerbos authorised principal `sub` to run command `cmd` with exactly these
// arguments, just now, once" (design §5). The control channel's own principal (ControlPrincipal) is
// the ERP SERVICE that called; the editorial principal is the PERSON or agent on whose behalf it
// called. Every content write carries one, and it is what audit rows and content_versions.created_by
// attribute the write to.
//
// Gate position: L1 mTLS -> L2 token -> L3 scope -> L4 WS4 -> **L2e editorial** -> validation.
// EditorialAssertionGuard (./editorial-assertion.guard.ts) runs after CommandAuthorizationGuard, so
// the cheaper refusals never reach the resolver (and WSK-40's resolver never writes a replay-store
// entry for a request that was going to be refused anyway).
//
// Implementations, bound in ../control.module.ts by ONE line that WSK-40 swaps:
//   NODE_ENV=test -> DevModeEditorialPrincipalResolver (an UNVERIFIED header, as WSK-21's dev stubs);
//   otherwise     -> NotConfiguredEditorialPrincipalResolver (503 editorial-keys-not-configured),
//                    until WSK-40 binds the real Ed25519 assertion verifier. No crypto lives here.
import type { CommandName } from "../command-types";
import type { ControlRequest } from "./control-request";
import { ControlProblem } from "../content/content-problem";

export interface EditorialPrincipal {
  /** ERP users.id — opaque to WebDesk (D39). Attribution only. */
  sub: string;
  /** Attribution only, never authorisation. */
  pk: "human" | "automation" | "agent";
  /** The acting agent persona; present iff pk = agent. */
  agt?: string;
  /** The original requester of an approved command (maker), when the caller is the checker. */
  req?: string;
  /** HIGH commands: the WS4 approval id this assertion is cross-bound to. */
  apr?: string;
  /** Single-use assertion id. */
  jti: string;
  /**
   * WSK-49b: true iff the signed assertion carried `ce: true` ("client editor"). Absent means false, and
   * the principal is then exactly what it was before WSK-49. A client principal is held to the
   * client-editable paths of a composition and to the client command allow-list (./client-editor.ts).
   */
  clientEditor?: boolean;
  /**
   * M5-W1e: true iff the signed assertion carried `xc: true` ("contributor", a freelance writer with an ERP login). Absent means
   * false, and the principal is then exactly what it was before W1e. A contributor is held to CONTRIBUTOR_COMMANDS
   * (./contributor-editor.ts). Never set together with `clientEditor`: the verifier refuses an assertion that carries both.
   */
  contributor?: boolean;
}

export const EDITORIAL_PRINCIPAL_RESOLVER: unique symbol = Symbol("EDITORIAL_PRINCIPAL_RESOLVER");

export interface EditorialPrincipalResolver {
  /**
   * Resolves (and, in WSK-40's implementation, verifies and consumes) the editorial principal of a
   * request. `command` is the route's @Command; `args` is route params merged with the body, the
   * same object CommandAuthorizationGuard hashes for WS4, so an assertion's `cmh` binds exactly the
   * arguments that will be validated and executed. Throws a ControlProblem (401/403/503) to refuse.
   */
  resolve(req: ControlRequest, command: CommandName, args: Record<string, unknown>): Promise<EditorialPrincipal>;
}

export type EditorialRequest = ControlRequest & { editorial?: EditorialPrincipal };

/** Handlers read the principal through this, never through a bare `req.editorial!`. */
export function requireEditorialPrincipal(req: EditorialRequest): EditorialPrincipal {
  if (!req.editorial) {
    // Wiring bug (a content route without EditorialAssertionGuard), not a caller error. 401 rather
    // than 500 so a misconfiguration can never be read as "the write happened".
    throw new ControlProblem(
      401,
      "editorial-assertion-missing",
      "Editorial assertion missing",
      "No editorial principal was resolved for this request.",
    );
  }
  return req.editorial;
}

export const EDITORIAL_PRINCIPAL_KINDS: ReadonlyArray<EditorialPrincipal["pk"]> = ["human", "automation", "agent"];
