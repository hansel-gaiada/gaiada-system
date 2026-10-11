// WSK-49b (ruling WSK-D59) — the client-editor marker and the commands it may reach.
//
// A CLIENT EDITOR is a principal whose signed editorial assertion carries `ce: true` (verified in
// ./editorial-assertion.ts, exposed as EditorialPrincipal.clientEditor). The marker only ever RESTRICTS:
// without it nothing here runs and behaviour is exactly what it was before WSK-49. That makes the ERP's
// duty explicit and one-sided: it MUST set `ce` on every assertion it mints for a client principal
// (ticket 49c). An assertion without `ce` is a full-power staff assertion; WebDesk cannot tell that a
// client forgot to be marked.
//
// Two checks hang off the marker:
//   1. this file: which COMMANDS a client may run at all (an allow-list, CLIENT_EDITOR_COMMANDS in
//      ../command-types.ts). Called by EditorialAssertionGuard for every editorial route, and again at the
//      top of each service method, so a service called by anything but the guarded controller is held to
//      the same list.
//   2. content-commands.service.ts: which PATHS of an item a client may change (the vocabulary's one rule,
//      delivery/vocabulary/client-editable.ts).
import { CLIENT_EDITOR_COMMANDS, type CommandName } from "../command-types";
import { ControlProblem } from "../content/content-problem";

export const CLIENT_COMMAND_NOT_ALLOWED = "client-command-not-allowed";
export const FIELD_NOT_CLIENT_EDITABLE = "field-not-client-editable";

/** What the check needs of a principal: an EditorialPrincipal satisfies it as is. */
export interface ClientMarked {
  clientEditor?: boolean;
}

export const isClientEditor = (p: ClientMarked): boolean => p.clientEditor === true;

/** 403 client-command-not-allowed when a client principal names a command that is not on the allow-list. */
export function assertClientMayRun(principal: ClientMarked, command: CommandName): void {
  if (!isClientEditor(principal) || CLIENT_EDITOR_COMMANDS.has(command)) return;
  throw new ControlProblem(
    403,
    CLIENT_COMMAND_NOT_ALLOWED,
    "Command not allowed for a client editor",
    `A client editor may not run ${command}. Clients create, update, restore, publish, preview and add media; ` +
      "they never delete, unpublish, schedule or delete media. Nothing was changed.",
  );
}

/** 422 field-not-client-editable, listing every offending JSON pointer (capped; `total` says how many). */
export function fieldNotClientEditable(pointers: string[], detail?: string): ControlProblem {
  const MAX_LISTED = 50;
  return new ControlProblem(
    422,
    FIELD_NOT_CLIENT_EDITABLE,
    "Field not client-editable",
    detail ?? "A client editor may change only the fields the composition marks client-editable (ui.clientEditable). Nothing was written.",
    {
      issues: pointers.slice(0, MAX_LISTED).map((path) => ({ path, message: "this part of the item is not client-editable" })),
      total: pointers.length,
    },
  );
}
