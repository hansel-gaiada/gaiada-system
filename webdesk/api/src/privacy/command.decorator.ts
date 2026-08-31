import { SetMetadata } from "@nestjs/common";
import type { PrivacyCommandName } from "./command-types";

// A DELIBERATELY SEPARATE metadata key from control/command.decorator.ts's COMMAND_META_KEY —
// this module's guard (policy/privacy-command-authorization.guard.ts) reads this key against
// PRIVACY_COMMAND_REGISTRY, never against control's COMMAND_REGISTRY, so the two never collide or
// silently shadow one another even though both controllers currently share the same
// `control/v1/tenants` route prefix. On merge into control/**, this decorator collapses into a
// plain `@Command(...)` reusing the real COMMAND_META_KEY — see command-types.ts's header.
export const PRIVACY_COMMAND_META_KEY = "webdesk:privacy:control:command";

export const PrivacyCommand = (name: PrivacyCommandName) => SetMetadata(PRIVACY_COMMAND_META_KEY, name);
