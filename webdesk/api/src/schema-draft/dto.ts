// WSK-32 — request validation for this module's one route. Reuses the api-keys module's uuid/
// tenant-slug validators (the same shared helper ../control/dto.ts already reuses for the exact
// same reason: one place owns "what a uuid string looks like").
import { BadRequestException } from "@nestjs/common";

export { assertUuid, assertTenantSlug } from "../api-keys/dto";

export function assertNonEmptyString(value: unknown, field: string, maxLength = 20000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new BadRequestException(`${field} must be a non-empty string (max ${maxLength} chars)`);
  }
  return value;
}
