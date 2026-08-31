import { SetMetadata } from "@nestjs/common";
import type { CommandName } from "./command-types";

export const COMMAND_META_KEY = "webdesk:control:command";

/**
 * Attaches a command's identity to a route handler. `policy/command-authorization.guard.ts`
 * reads it and looks the full `CommandMeta` (impact class + required scope) up in
 * `COMMAND_REGISTRY` — the handler never states its own impact class, so the registry stays the
 * single source of truth every route and every test agree on.
 */
export const Command = (name: CommandName) => SetMetadata(COMMAND_META_KEY, name);
