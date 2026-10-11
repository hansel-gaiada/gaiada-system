// WSK-21 — the "lifecycle" quarter of the C-05 command set: tenant + site + environment
// provision/archive, as idempotent commands (design §04's own DDL is the domain model; nothing
// here alters it).
//
// M3 T5a — every command here except site.archive runs in the shared command envelope
// (../command-envelope.ts): ONE transaction holding the `control.<cmd>` audit row FIRST (on the
// two HIGH archives it carries ws4_approval_id, which claims the approval before the write), the
// domain write on the same client, and the durable replay record. tenant.provision/archive run under
// the platform scope (tenant_id NULL audit row), the rest under the tenant's. Nothing runs after
// commit. Ids of the rows being created are generated before the transaction, because the audit row
// that names them is its first statement.
//
// The two ARCHIVE commands resolve their tenant WHATEVER ITS STATUS (M3 T8): a retry of an archive
// (same Idempotency-Key, response lost) arrives when the tenant is already archived, and must reach the
// envelope so begin() answers it from the stored record. Only a FRESH run needs an active tenant, and it
// is refused inside the effect with the same 404 as before.
//
// site.archive is the exception: it has no effect (the `sites` table has no status column, so it only
// ever answers 501), takes no idempotency key, and records its audit row through CommandAuditService.
// It consumes no approval and changes nothing, so there is nothing to claim.
import { ConflictException, Injectable, NotFoundException, NotImplementedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { CommandEnvelope } from "../command-envelope";

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
    private readonly commandAudit: CommandAuditService,
    private readonly envelope: CommandEnvelope,
    private readonly auditHash: AuditService,
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
          return { result: { tenant: rows[0] } };
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
   * §04's `sites` table has NO status column — nowhere to record an archived state.
   * `check-rls-integrity.mjs`'s heuristic and every other table in this ledger models lifecycle
   * via a `status` text column; sites was never given one. Per the ticket's own instruction
   * ("Schema changes go through the senior-db seat... do not improvise DDL"), this command
   * authenticates/authorizes/audits exactly like a real one, then refuses with a structured,
   * documented error rather than inventing a fake success or silently no-op'ing. Needs a
   * senior-db-approved migration adding `sites.status` before this can execute for real.
   */
  async archiveSite(input: { tenantSlug: string; siteId: string; actor: string }): Promise<never> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "site.archive",
      actor: input.actor,
      args: { tenantSlug: input.tenantSlug, siteId: input.siteId, outcome: "not-yet-available" },
    });

    throw new NotImplementedException({
      type: "https://webdesk.gaiada.online/errors/site-archive-not-yet-available",
      title: "Site archive is not yet available",
      status: 501,
      detail:
        "0001_platform_core.sql's `sites` table has no status column, so there is nowhere to record an " +
        "archived state. This command's auth/idempotency/audit machinery all ran correctly; it has no " +
        "domain effect to perform yet. Needs a senior-db-approved migration adding `sites.status` before " +
        "this can execute.",
      instance: `/control/v1/tenants/${input.tenantSlug}/sites/${input.siteId}/archive`,
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
        const siteCheck = await client.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
        if (!siteCheck.rows[0]) throw new NotFoundException("site not found for this tenant");
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
