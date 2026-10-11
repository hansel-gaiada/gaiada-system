// WSK-21 — request validation helpers, control-plane-specific. Reuses WSK-05's uuid/tenant-slug/
// api-key-scope validators (`../api-keys/dto`) rather than reimplementing them — same regex, same
// error shape, one place that owns "what a uuid string looks like" for this whole service.
import { BadRequestException } from "@nestjs/common";

export { assertUuid, assertTenantSlug, assertScope } from "../api-keys/dto";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;

/** A NEW tenant slug being provisioned (as opposed to `assertTenantSlug`, which accepts any non-empty string for an EXISTING route param). */
export function assertSlug(value: unknown, field = "slug"): string {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new BadRequestException(`${field} must be a lowercase, dash-separated slug`);
  }
  return value;
}

export function assertSiteKind(value: unknown): "astro" | "node" | "wp" {
  if (value !== "astro" && value !== "node" && value !== "wp") {
    throw new BadRequestException("kind must be 'astro', 'node' or 'wp'");
  }
  return value;
}

export function assertEnvName(value: unknown): "staging" | "production" {
  if (value !== "staging" && value !== "production") {
    throw new BadRequestException("name must be 'staging' or 'production'");
  }
  return value;
}

export function assertNonEmptyString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(`${field} must be a non-empty string (max ${maxLength} chars)`);
  }
  return value;
}

/**
 * Every mutating control-plane command requires an `Idempotency-Key` header (ticket AC: "Use a
 * caller-supplied idempotency key"). Read-only commands (schema.propose, contract.read, job
 * queries) never call this — nothing to replay-protect when nothing is written.
 */
export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 200) {
    throw new BadRequestException(
      "Idempotency-Key header is required (>=8 chars) for this command — every control-plane " +
        "mutation must be replay-safe under a double-fire (design §07 AC)",
    );
  }
  return value;
}

export function assertPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * The locale rule, as the rest of the service already applies it (not a new one): a locale is an OPAQUE,
 * non-empty string of at most 35 characters (content-commands.controller.ts `str(locale, 35)`), read
 * trimmed (delivery/vocabulary/locale.ts `resolveRequestedLocale`, so a value with surrounding whitespace
 * could never be requested) and matched by exact string equality against the tenant's declared set
 * (content-commands.service.ts, media-commands.service.ts). There is deliberately no BCP 47 grammar.
 */
export const LOCALE_MAX_CHARS = 35;

function assertLocale(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > LOCALE_MAX_CHARS || value.trim() !== value) {
    throw new BadRequestException(`${field} must be a non-empty locale string without surrounding whitespace (max ${LOCALE_MAX_CHARS} chars)`);
  }
  return value;
}

/**
 * tenant.provision's optional locale declaration (WSK-D18). Both absent -> null (the column defaults
 * apply, exactly as before). Both given -> validated: `locales` a non-empty array of valid, distinct
 * locales, and `defaultLocale` one of them. One without the other is refused: guessing the missing half
 * would be a silent contract decision.
 */
export function assertTenantLocales(defaultLocale: unknown, locales: unknown): { defaultLocale: string; locales: string[] } | null {
  if (defaultLocale === undefined && locales === undefined) return null;
  if (defaultLocale === undefined || locales === undefined) {
    throw new BadRequestException("defaultLocale and locales must be given together (or both omitted)");
  }
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new BadRequestException("locales must be a non-empty array of locale strings");
  }
  const list = locales.map((l, i) => assertLocale(l, `locales[${i}]`));
  if (new Set(list).size !== list.length) {
    throw new BadRequestException("locales must not contain duplicates");
  }
  const def = assertLocale(defaultLocale, "defaultLocale");
  if (!list.includes(def)) {
    throw new BadRequestException("defaultLocale must be one of locales");
  }
  return { defaultLocale: def, locales: list };
}
