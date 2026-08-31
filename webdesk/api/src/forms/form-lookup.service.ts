// WSK-10 — resolves a form_defs row and its site's allowed origins. Unlike
// tenants/tenant-lookup.service.ts's `bySlug()`, this file has NO platform-context escape hatch
// available to it: 0003_forms.sql's `tenant_isolation` policy on `form_defs` is single-mode
// (`tenant_id = webdesk_tenant_ctx()`, no `OR webdesk_platform_ctx()` clause the way
// `tenants`/`audit_entries` get in 0001) — so `form_defs` can ONLY ever be read once a real tenant
// context is already active. That is WHY this ticket's route is
// `POST /v1/t/:tenantSlug/forms/:formId/submit` (tenant slug resolved FIRST, exactly like
// content/media's own `v1/t/:tenantSlug/...` routes) rather than the ticket brief's literal
// `POST /v1/forms/:formId/submit` — see the ticket report's "deviation from the literal endpoint
// path" section for the full reasoning; this comment is the load-bearing one.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type FormDefRow = {
  id: string;
  tenant_id: string;
  site_id: string;
  key: string;
  schema: unknown;
  notify: unknown;
  retention_days: number;
  consent_notice_version: string | null;
};

@Injectable()
export class FormLookupService {
  constructor(private readonly db: DbService) {}

  /** MUST run with `tenantId`'s GUC already active (db.withTenant / enterTenantContext) — this
   *  method issues a plain query and relies entirely on RLS to scope it; it does not repeat
   *  `tenant_id = $2` itself only because form_defs' PK (`id`) is already globally unique and a
   *  cross-tenant `id` is invisible under RLS regardless — same "no existence oracle" shape as
   *  media.service.ts's `getPublicAsset`. */
  async byId(formId: string): Promise<FormDefRow | null> {
    const { rows } = await this.db.query<FormDefRow>(
      `SELECT id, tenant_id, site_id, key, schema, notify, retention_days, consent_notice_version
         FROM form_defs WHERE id = $1`,
      [formId],
    );
    return rows[0] ?? null;
  }

  /** Every non-null `environments.domain` for the given site — the per-tenant CORS origin
   *  allowlist source (design §11: "strict per-tenant CORS origin allowlist"; the schema carries
   *  no dedicated CORS-config column, so this ticket derives the allowlist from the domains a
   *  site's environments are already configured with — see the ticket report's "underspecified"
   *  section). Both `staging` and `production` environments' domains are honoured, so a form
   *  embedded on a staging preview is not blocked by design. */
  async allowedDomainsForSite(siteId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ domain: string }>(
      `SELECT domain FROM environments WHERE site_id = $1 AND domain IS NOT NULL AND domain <> ''`,
      [siteId],
    );
    return rows.map((r) => r.domain);
  }
}
