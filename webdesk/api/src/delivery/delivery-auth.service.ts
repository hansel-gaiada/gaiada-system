// WSK-48a — the tenant + key lookups the /v1 router is injected with.
//
//   resolveTenantBySlug — the api's one legitimate cross-tenant read (webdesk.platform_ctx), same
//     mechanism as TenantLookupService.bySlug, but selecting the two locale columns the envelope
//     needs (default_locale, locales), which TenantLookupService does not carry. Kept here rather
//     than widening that shared service (it is outside this module's owned paths, and every other
//     caller would pay for columns it never reads).
//   resolveApiKey — ApiKeysService.resolve(): THE key-hash implementation (crypto/api-key-hash.ts,
//     one place, one pepper), re-reading api_keys on every call. This is what retires WSK-D24's
//     accepted "key hash duplicated in two services" cost.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { ApiKeysService } from "../api-keys/api-keys.service";
import type { ResolvedApiKey, ResolvedTenant } from "./auth";

@Injectable()
export class DeliveryAuthService {
  constructor(private readonly db: DbService, private readonly apiKeys: ApiKeysService) {}

  async resolveTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
    return this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        slug: string;
        status: string;
        default_locale: string;
        locales: string[];
      }>(`SELECT id, slug, status, default_locale, locales FROM tenants WHERE slug = $1`, [slug]);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        slug: row.slug,
        status: row.status,
        defaultLocale: row.default_locale,
        locales: row.locales,
      };
    });
  }

  async resolveApiKey(tenant: ResolvedTenant, plaintextKey: string): Promise<ResolvedApiKey | null> {
    const resolved = await this.apiKeys.resolve(tenant.id, plaintextKey);
    if (!resolved) return null;
    return {
      ...resolved,
      tenantSlug: tenant.slug,
      tenantDefaultLocale: tenant.defaultLocale,
      tenantLocales: tenant.locales,
    };
  }
}
