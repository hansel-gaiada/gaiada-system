// WSK-25 — reuses ../control/dto.ts's validators (a plain export, not a module boundary — no
// ControlModule provider dependency implied by this import) rather than reimplementing
// uuid/tenant-slug/idempotency-key checks a third time in this codebase.
import { BadRequestException } from "@nestjs/common";
import type { ContentBundle } from "./content-bundle.types";

export { assertUuid, assertTenantSlug, assertIdempotencyKey } from "../control/dto";

export function assertOptionalVersion(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new BadRequestException("version must be a non-empty string (max 200 chars) when provided");
  }
  return value;
}

/** Minimal shape validation — full referential integrity (does every contentItem's collectionKey exist?) is checked at apply time, where the error is more actionable. */
export function assertContentBundle(value: unknown): ContentBundle {
  if (typeof value !== "object" || value === null) {
    throw new BadRequestException("bundle must be a JSON object (see content-bundle.types.ts's ContentBundle shape)");
  }
  const b = value as Record<string, unknown>;
  if (!Array.isArray(b.collections) || !Array.isArray(b.contentItems) || !Array.isArray(b.mediaAssets)) {
    throw new BadRequestException("bundle.collections, bundle.contentItems and bundle.mediaAssets must all be arrays");
  }
  return {
    siteId: typeof b.siteId === "string" ? b.siteId : "",
    exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : new Date().toISOString(),
    collections: b.collections as ContentBundle["collections"],
    contentItems: b.contentItems as ContentBundle["contentItems"],
    mediaAssets: b.mediaAssets as ContentBundle["mediaAssets"],
  };
}
