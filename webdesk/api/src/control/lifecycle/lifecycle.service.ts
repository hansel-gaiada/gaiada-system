// WSK-21 — the "lifecycle" quarter of the C-05 command set: tenant + site + environment
// provision/archive, as idempotent commands (design §04's own DDL is the domain model; nothing
// here alters it).
//
// M3 T5a — every command here runs in the shared command envelope
// (../command-envelope.ts): ONE transaction holding the `control.<cmd>` audit row FIRST (on the
// HIGH archives it carries ws4_approval_id, which claims the approval before the write), the
// domain write on the same client, and the durable replay record. tenant.provision/archive run under
// the platform scope (tenant_id NULL audit row), the rest under the tenant's (site.archive included).
// Ids of the rows being
// created are generated before the transaction, because the audit row that names them is its first
// statement.
//
// M6-P4r-b: tenant.provision is the one command here with a post-commit step. Its `after` queues the
// new tenant's contract codegen (ContractCodegenTrigger: fail-soft, never rejects, and never runs on a
// replay), so a tenant gets a current contracts/<slug>/latest.json without a manual step. The response
// and the stored replay record do not depend on it.
//
// The ARCHIVE commands resolve their tenant WHATEVER ITS STATUS (M3 T8): a retry of an archive
// (same Idempotency-Key, response lost) arrives when the tenant is already archived, and must reach the
// envelope so begin() answers it from the stored record. Only a FRESH run needs an active tenant, and it
// is refused inside the effect with the same 404 as before.
//
// site.archive (owner ruling 2026-10-12: archiving a site TAKES an approval; migration 0019 added
// sites.status) is the site-scope mirror of tenant.archive: the same envelope, the same WS4 claim, one
// terminal UPDATE. Everything an archived tenant stops doing, an archived site stops doing at site scope
// (see 0019 and the README's "site.archive" section for the list of read sites).
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandEnvelope } from "../command-envelope";
import { ContractCodegenTrigger } from "../../codegen/contract-codegen.trigger";

interface TenantRow {
  id: string;
  slug: string;
  company_ref: string;
  status: string;
  created_at: string;
  default_locale: string;
  locales: string[];
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly tenants: TenantLookupService,
    private readonly envelope: CommandEnvelope,
    private readonly auditHash: AuditService,
    private readonly codegen: ContractCodegenTrigger,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.resolveTenant(slug);
    if (tenant.status !== "active") {
      throw new NotFoundException("tenant not found");
    }
    return tenant;
  }

  /**
   * The tenant whatever its status. The two ARCHIVE commands use this, not resolveActiveTenant: once the
   * tenant is archived, a retry of the same archive (same Idempotency-Key, response lost) must reach the
   * envelope so begin() can answer it from the stored record. Whether the tenant must be active is
   * then decided only for a FRESH run, inside the effect (see requireActive).
   */
  private async resolveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant) throw new NotFoundException("tenant not found");
    return tenant;
  }

  // ---------------------------------------------------------------------------
  // Tenant
  // ---------------------------------------------------------------------------

  async provisionTenant(input: {
    slug: string;
    companyRef: string;
    /** Both or neither (the controller validates). Absent: the column defaults ('id-ID') apply, as before. */
    defaultLocale?: string;
    locales?: string[];
    actor: string;
    idempotencyKey: string;
  }) {
    // The locale keys join the hashed body ONLY when declared, so a replay with different locales is a
    // key reuse (409), while every pre-existing body hashes exactly as it did.
    const declared = input.locales ? { defaultLocale: input.defaultLocale as string, locales: input.locales } : null;
    // AuditArgs are scalars, so the list is hashed as its JSON text (order matters: it is part of the body).
    const args = { slug: input.slug, companyRef: input.companyRef, ...(declared ? { defaultLocale: declared.defaultLocale, locales: JSON.stringify(declared.locales) } : {}) };
    const tenantId = randomUUID();

    return this.envelope.run<{ tenant: TenantRow }>({
      command: "tenant.provision",
      scope: { kind: "platform" },
      scopeKey: `platform:tenant.provision:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, tenantId },
      ws4ApprovalId: null,
      effect: async (client) => {
        try {
          const { rows } = declared
            ? await client.query<TenantRow>(
                `INSERT INTO tenants (id, slug, company_ref, default_locale, locales) VALUES ($1, $2, $3, $4, $5::text[])
                 RETURNING id, slug, company_ref, status, created_at, default_locale, locales`,
                [tenantId, input.slug, input.companyRef, declared.defaultLocale, declared.locales],
              )
            : await client.query<TenantRow>(
                `INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)
                 RETURNING id, slug, company_ref, status, created_at, default_locale, locales`,
                [tenantId, input.slug, input.companyRef],
              );
          return {
            result: { tenant: rows[0] },
            // Strictly after the commit; the trigger swallows and logs every failure.
            after: async () => void (await this.codegen.requestRun(input.slug, "tenant.provision")),
          };
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException(`tenant slug '${input.slug}' already exists — provisioning with a NEW idempotency key does not rename or reuse an existing tenant`);
          }
          throw err;
        }
      },
    });
  }

  async archiveTenant(input: { slug: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    // Any status: an archived tenant must still reach the envelope so a replay is answered (see resolveTenant).
    const tenant = await this.resolveTenant(input.slug);
    const args = { slug: input.slug };

    return this.envelope.run<{ tenant: { id: string; slug: string; status: string } }>({
      command: "tenant.archive",
      scope: { kind: "platform" },
      scopeKey: `platform:tenant.archive:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, tenantId: tenant.id },
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => {
        // A fresh run needs an ACTIVE tenant: the same 404 as before this fix, decided atomically by the
        // UPDATE itself (an archived tenant matches no row), so the throw rolls the audit row back.
        const { rows } = await client.query<{ id: string; slug: string; status: string }>(
          `UPDATE tenants SET status = 'archived' WHERE slug = $1 AND status = 'active' RETURNING id, slug, status`,
          [input.slug],
        );
        if (!rows[0]) throw new NotFoundException("tenant not found");
        return { result: { tenant: rows[0] } };
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Site
  // ---------------------------------------------------------------------------

  async provisionSite(input: { tenantSlug: string; kind: "astro" | "node" | "wp"; name: string; actor: string; idempotencyKey: string }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, kind: input.kind, name: input.name };
    const siteId = randomUUID();

    return this.envelope.run<{ site: { id: string; kind: string; name: string; created_at: string } }>({
      command: "site.provision",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:site.provision:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, siteId },
      ws4ApprovalId: null,
      effect: async (client) => {
        const { rows } = await client.query<{ id: string; kind: string; name: string; created_at: string }>(
          `INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, $3, $4)
           RETURNING id, kind, name, created_at`,
          [siteId, tenant.id, input.kind, input.name],
        );
        return { result: { site: rows[0] } };
      },
    });
  }

  /**
   * site.archive: the site-scope mirror of archiveTenant. HIGH, always WS4-gated; one terminal write,
   * sites.status 'active' -> 'archived' (0019), with no way back. Same shape as the tenant one:
   *   - the tenant is resolved WHATEVER ITS STATUS, so a retry (same Idempotency-Key, response lost) after
   *     the archive reaches the envelope and is answered from the stored record; only a FRESH run needs an
   *     active tenant, and is refused inside the effect with the same 404 as before;
   *   - a fresh run on a site that is already archived is refused inside the effect (409), which rolls the
   *     audit row back and leaves the approval unclaimed, exactly as an archived tenant's 404 does;
   *   - an unknown site, or another tenant's, is a 404 (the UPDATE is tenant-scoped and RLS-scoped).
   * What archiving changes about reads, writes, schedules and previews is not done here: it is decided by
   * the status the other code paths already read (api-keys resolve, resolveTenantSite, the scheduler tick,
   * preview reads).
   */
  async archiveSite(input: { tenantSlug: string; siteId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, siteId: input.siteId };

    return this.envelope.run<{ site: { id: string; name: string; status: string } }>({
      command: "site.archive",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:site.archive:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: args,
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => {
        // Fresh run only: an archived tenant gets the same 404 as every other command on it.
        if (tenant.status !== "active") throw new NotFoundException("tenant not found");
        const { rows } = await client.query<{ id: string; name: string; status: string }>(
          `UPDATE sites SET status = 'archived' WHERE id = $1 AND tenant_id = $2 AND status = 'active'
           RETURNING id, name, status`,
          [input.siteId, tenant.id],
        );
        if (!rows[0]) {
          const { rows: existing } = await client.query<{ status: string }>(`SELECT status FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
          if (existing[0]) throw new ConflictException("site is already archived");
          throw new NotFoundException("site not found for this tenant");
        }
        return { result: { site: rows[0] } };
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------

  async provisionEnvironment(input: {
    tenantSlug: string;
    siteId: string;
    name: "staging" | "production";
    domain: string | null;
    actor: string;
    idempotencyKey: string;
  }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, siteId: input.siteId, name: input.name, domain: input.domain };
    const envId = randomUUID();

    return this.envelope.run<{ environment: { id: string; name: string; domain: string | null; status: string } }>({
      command: "environment.provision",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:environment.provision:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, envId },
      ws4ApprovalId: null,
      effect: async (client) => {
        const siteCheck = await client.query<{ status: string }>(`SELECT status FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
        if (!siteCheck.rows[0]) throw new NotFoundException("site not found for this tenant");
        if (siteCheck.rows[0].status !== "active") throw new ConflictException("site is archived — an archived site accepts no new environments");
        try {
          const { rows } = await client.query<{ id: string; name: string; domain: string | null; status: string }>(
            `INSERT INTO environments (id, site_id, tenant_id, name, domain, status)
             VALUES ($1, $2, $3, $4, $5, 'provisioning')
             RETURNING id, name, domain, status`,
            [envId, input.siteId, tenant.id, input.name, input.domain],
          );
          return { result: { environment: rows[0] } };
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException(`environment '${input.name}' already exists for this site — provisioning with a NEW idempotency key does not create a second one (UNIQUE(site_id,name))`);
          }
          throw err;
        }
      },
    });
  }

  async archiveEnvironment(input: { tenantSlug: string; envId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    // Any status: same reason as archiveTenant. A replay after the tenant itself was archived still answers.
    const tenant = await this.resolveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, envId: input.envId };

    return this.envelope.run<{ environment: { id: string; name: string; status: string } }>({
      command: "environment.archive",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:environment.archive:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: args,
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => {
        // Fresh run only: an archived tenant gets the same 404 as before this fix.
        if (tenant.status !== "active") throw new NotFoundException("tenant not found");
        const { rows } = await client.query<{ id: string; name: string; status: string }>(
          `UPDATE environments SET status = 'archived' WHERE id = $1 AND tenant_id = $2
           RETURNING id, name, status`,
          [input.envId, tenant.id],
        );
        if (!rows[0]) throw new NotFoundException("environment not found for this tenant");
        return { result: { environment: rows[0] } };
      },
    });
  }
}
