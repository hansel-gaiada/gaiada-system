// M5-W1e (ruling WSK-D84; writers' room design D10 and section 3.1 item 7) -- the contributor marker and the commands it may reach.
//
// A CONTRIBUTOR is a freelance writer, translator or SEO reviewer with an ERP login (`users.kind = 'contributor'`). The ERP's
// editorial-assertion signer marks every assertion it mints for one with `xc: true`, read from the assembled principal's kind and
// never from a request (platform-nest/src/modules/webdev/webdesk-editorial-signer.ts). The verifier exposes it as
// EditorialPrincipal.contributor. Like `ce` (./client-editor.ts) the marker only ever RESTRICTS: without it nothing here runs, and
// an assertion that lacks it is a full-power staff assertion, so the ERP's duty to set it is the whole of its side.
//
// `xc` and `ce` are mutually exclusive: a contributor is never a client editor. The verifier refuses an assertion that carries
// both (401 editorial-assertion-claims), so the two restrictions never have to be combined.
//
// This file holds the one check: which COMMANDS a contributor may run at all (an allow-list, CONTRIBUTOR_COMMANDS in
// ../command-types.ts). EditorialAssertionGuard calls it for every editorial route, and each service method calls it again, so a
// service reached by anything but the guarded controller is held to the same list.
import { CONTRIBUTOR_COMMANDS, type CommandName } from "../command-types";
import { ControlProblem } from "../content/content-problem";

export const CONTRIBUTOR_COMMAND_NOT_ALLOWED = "contributor-command-not-allowed";

/** What the check needs of a principal: an EditorialPrincipal satisfies it as is. */
export interface ContributorMarked {
  contributor?: boolean;
}

export const isContributor = (p: ContributorMarked): boolean => p.contributor === true;

/** 403 contributor-command-not-allowed when a contributor principal names a command that is not on the allow-list. */
export function assertContributorMayRun(principal: ContributorMarked, command: CommandName): void {
  if (!isContributor(principal) || CONTRIBUTOR_COMMANDS.has(command)) return;
  throw new ControlProblem(
    403,
    CONTRIBUTOR_COMMAND_NOT_ALLOWED,
    "Command not allowed for a contributor",
    `A contributor may not run ${command}. Contributors draft, edit, preview, submit, comment and sign off SEO; ` +
      "they never publish, approve, schedule, unpublish, delete, manage editorial settings or write media. Nothing was changed.",
  );
}
