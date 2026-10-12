// WSK-51 — tenant.list, the platform-level read behind the ERP's cross-company wall (write-plane
// design §4, §9: `resolveEditableSite` returns 404 unless `tenants.company_ref` equals the caller's
// company, which it learns here).
//
// `tenants.company_ref` (0001_platform_core.sql) is the owning ERP company's id (Zone A companies.id,
// opaque here). The list is FILTERED BY IT IN SQL: another company's tenant never leaves the
// database, so no caller-side filtering is trusted. companyRef is REQUIRED (the controller answers
// 400 without it): a caller that forgot the filter must get an error, never every company's tenants.
//
// Two contexts, because the schema has two: `tenants` is read under platform_ctx (its SELECT policy
// admits platform_ctx), but `sites` and `environments` have only the tenant_isolation policy, so each
// tenant's sites and environments are read under THAT tenant's context. Archived tenants are listed
// (their `status` says so): the registry is the truth, and hiding them would make a retired site look
// like it never existed. Not audited (a read; see content-reads.service.ts's header).
import { Injectable } from "@nestjs/common";
import { DbService } from "../../db/db.service";

export interface TenantListEnvironment {
  envId: string;
  name: string;
  domain: string | null;
  status: string;
}

export interface TenantListSite {
  siteId: string;
  name: string;
  kind: string;
  /** 'active' | 'archived' (0019). An archived site is listed, never hidden: the staff UI shows it as archived. */
  status: string;
  environments: TenantListEnvironment[];
}

export interface TenantListEntry {
  slug: string;
  status: string;
  defaultLocale: string;
  locales: string[];
  sites: TenantListSite[];
}

@Injectable()
export class TenantReadsService {
  constructor(private readonly db: DbService) {}

  async list(companyRef: string): Promise<{ tenants: TenantListEntry[] }> {
    const tenants = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; status: string; default_locale: string; locales: string[] }>(
        `SELECT id, slug, status, default_locale, locales FROM tenants WHERE company_ref = $1::uuid ORDER BY slug`,
        [companyRef],
      );
      return rows;
    });

    const out: TenantListEntry[] = [];
    for (const t of tenants) {
      const sites = await this.db.withTenant(t.id, (db) =>
        db.transaction(async (client) => {
          await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const { rows: siteRows } = await client.query<{ id: string; name: string; kind: string; status: string }>(
            `SELECT id, name, kind, status FROM sites WHERE tenant_id = $1 ORDER BY created_at, id`,
            [t.id],
          );
          const { rows: envRows } = await client.query<{ id: string; site_id: string; name: string; domain: string | null; status: string }>(
            `SELECT id, site_id, name, domain, status FROM environments WHERE tenant_id = $1 ORDER BY name, id`,
            [t.id],
          );
          return siteRows.map(
            (s): TenantListSite => ({
              siteId: s.id,
              name: s.name,
              kind: s.kind,
              status: s.status,
              environments: envRows
                .filter((e) => e.site_id === s.id)
                .map((e) => ({ envId: e.id, name: e.name, domain: e.domain, status: e.status })),
            }),
          );
        }),
      );
      out.push({ slug: t.slug, status: t.status, defaultLocale: t.default_locale, locales: t.locales, sites });
    }
    return { tenants: out };
  }
}
