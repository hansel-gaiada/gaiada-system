// WSK-37 — request validation helpers, same shape/discipline as ../api-keys/dto.ts.
import { BadRequestException } from "@nestjs/common";
import type { TenantWebhookEventKind } from "./tenant-webhook-event.types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_EVENT_KINDS: TenantWebhookEventKind[] = ["form.received"];

export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a uuid`);
  }
  return value;
}

export function assertTenantSlug(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new BadRequestException("tenantSlug must be a non-empty string");
  }
  return value;
}

/** Structural + scheme validation only — this is NOT the SSRF check (that is async, resolves DNS,
 *  and lives in ssrf-guard.ts; it runs at dispatch time on every attempt, not just here). This is
 *  the synchronous "is this even a well-formed https URL" gate every write path runs first, so an
 *  obviously-bad value (a bare string, an ftp:// URL, javascript:) never reaches the async check
 *  or the database at all. */
export function assertHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new BadRequestException(`${field} must be a non-empty URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new BadRequestException(`${field} must use https://`);
  }
  return value;
}

export function assertEventKinds(value: unknown): TenantWebhookEventKind[] {
  if (value === undefined) return ["form.received"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestException("eventKinds must be a non-empty array");
  }
  for (const kind of value) {
    if (!SUPPORTED_EVENT_KINDS.includes(kind)) {
      throw new BadRequestException(`unsupported event kind: ${String(kind)}`);
    }
  }
  return value as TenantWebhookEventKind[];
}

export function assertOptionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new BadRequestException(`${field} must be a boolean`);
  }
  return value;
}

export function assertOptionalDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 500) {
    throw new BadRequestException("description must be a string of at most 500 characters");
  }
  return value;
}
