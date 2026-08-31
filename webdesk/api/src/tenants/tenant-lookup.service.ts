// WSK-05 — resolves a tenant SLUG (the only tenant identifier a request arrives with — see
// 0001_platform_core.sql's own comment on api_keys.key_hash) into a tenant id. This is the one
// legitimate platform-level (cross-tenant) read in this service: there is no tenant context to
// scope by yet, which is exactly what `webdesk.platform_ctx` exists for (§04).
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type ResolvedTenant = { id: string; slug: string; status: string };

@Injectable()
export class TenantLookupService {
  constructor(private readonly db: DbService) {}

  async bySlug(slug: string): Promise<ResolvedTenant | null> {
    return this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<ResolvedTenant>(
        `SELECT id, slug, status FROM tenants WHERE slug = $1`,
        [slug],
      );
      return rows[0] ?? null;
    });
  }
}
