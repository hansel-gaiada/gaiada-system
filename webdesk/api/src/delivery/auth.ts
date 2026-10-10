// WSK-48a — what the /v1 router needs to know about WHO is asking, and where it gets it.
//
// The Payload-hosted copy (collections/auth.ts) carried its own copy of the key-hash algorithm
// ("hash duplicated in two services", WSK-D24's accepted cost). That cost is retired here: key
// resolution is `ApiKeysService.resolve()` — the same code, the same crypto/api-key-hash.ts, the
// same re-read-on-every-call (no cache, so a revoke dies on the very next request) the api's own
// ApiKeyAuthGuard uses. This file only adds the tenant facts the envelope needs (default locale,
// locale set), which the api's TenantLookupService deliberately does not carry.
import type { ResolvedApiKey as ApiKeyResolution } from "../api-keys/api-keys.service";

export interface ResolvedTenant {
  id: string;
  slug: string;
  status: string;
  defaultLocale: string;
  locales: string[];
}

/** The api's own resolution plus the tenant fields the envelope builders read. */
export type ResolvedApiKey = ApiKeyResolution & {
  tenantSlug: string;
  tenantDefaultLocale: string;
  tenantLocales: string[];
};

export function extractBearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
