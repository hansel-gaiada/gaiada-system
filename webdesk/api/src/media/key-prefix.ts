// WSK-07 — object-key construction. Every object key is prefixed with the owning tenant and site
// id, per-tenant, so a bucket listing (an operation only platform-level tooling ever performs —
// no client route lists a bucket) is self-evidently partitioned. The ACTUAL isolation guarantee
// this ticket's corrected AC cares about does not come from this prefix, though — it comes from
// media_assets' RLS-scoped row lookup in media.service.ts. This prefix is defense in depth and
// operational hygiene (so a human staring at the bucket can tell whose object is whose), not the
// security boundary itself.
import { randomUUID } from "node:crypto";

/** The object key WITHIN a bucket (bucket name is a separate S3-API parameter, never part of the key). */
export function buildObjectKey(tenantId: string, siteId: string, filename: string): string {
  const safeName = sanitizeFilename(filename);
  return `t/${tenantId}/${siteId}/${randomUUID()}-${safeName}`;
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}
