import { BadRequestException } from "@nestjs/common";
import type { ApiKeyScope } from "./api-keys.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a uuid`);
  }
  return value;
}

export function assertScope(value: unknown): ApiKeyScope {
  if (value !== "read" && value !== "write") {
    throw new BadRequestException("scope must be 'read' or 'write'");
  }
  return value;
}

export function assertTenantSlug(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new BadRequestException("tenantSlug must be a non-empty string");
  }
  return value;
}
