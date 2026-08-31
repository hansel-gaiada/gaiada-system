import { SetMetadata } from "@nestjs/common";
import type { ApiKeyScope } from "../api-keys/api-keys.service";

export const REQUIRE_SCOPE_KEY = "webdesk:requireScope";

/**
 * Marks a route as needing at least this scope. 'read' keys may only reach routes requiring
 * 'read'; 'write' keys satisfy either (write implies read — the design's §04 scope model is a
 * single value per key, not a set, so this ticket has to pick a composition rule; "write implies
 * read" is the ordinary REST convention and is the one applied here, everywhere in this service).
 */
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
