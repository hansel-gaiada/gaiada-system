// WSK-38 — request validation. Reuses ../control/dto.ts's assertTenantSlug/assertIdempotencyKey
// verbatim (same regex, same error shape, one place that owns "what these look like" — same
// convention control/dto.ts itself already documents for its own reuse of api-keys/dto.ts).
import { BadRequestException } from "@nestjs/common";

import { assertIdempotencyKey } from "../control/dto";

export { assertTenantSlug, assertIdempotencyKey } from "../control/dto";

/**
 * find and export take an OPTIONAL Idempotency-Key (erase requires one): absent, each call is a fresh
 * audited access; present, it must be a valid key, and the same key again is refused as withheld
 * (privacy.service.ts's header). A malformed key is refused before anything is claimed.
 */
export function assertOptionalIdempotencyKey(value: unknown): string | undefined {
  return value === undefined ? undefined : assertIdempotencyKey(value);
}

/** An identifier is whatever a form actually collected — email, phone, or any other value a
 *  submission's field carried (see identifier.ts's header). No format is assumed beyond
 *  "non-empty, bounded length" — validating it as an email/phone would silently exclude the "any
 *  other identifying field" case design §11/WSK-D22b explicitly calls for. */
export function assertIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 320) {
    throw new BadRequestException("identifier must be a non-empty string (max 320 chars)");
  }
  return value;
}
