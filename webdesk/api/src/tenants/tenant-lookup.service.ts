// WSK-05 — resolves a tenant SLUG (the only tenant identifier a request arrives with — see
// 0001_platform_core.sql's own comment on api_keys.key_hash) into a tenant id. This is the one
// legitimate platform-level (cross-tenant) read in this service: there is no tenant context to
// scope by yet, which is exactly what `webdesk.platform_ctx` exists for (§04).
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

/** `companyRef` is the tenant's Zone A companies.id (0001: `tenants.company_ref uuid NOT NULL`, opaque here). It is
 *  what a Zone B -> Zone A signed fact must carry as its envelope `tenantId`; the internal `id` means nothing to the ERP. */
export type ResolvedTenant = { id: string; slug: string; status: string; companyRef: string };

@Injectable()
export class TenantLookupService {
  constructor(private readonly db: DbService) {}

  async bySlug(slug: string): Promise<ResolvedTenant | null> {
    return this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<ResolvedTenant>(
        `SELECT id, slug, status, company_ref AS "companyRef" FROM tenants WHERE slug = $1`,
        [slug],
      );
      return rows[0] ?? null;
    });
  }
}
