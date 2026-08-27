// WSK-21 — the "lifecycle" quarter of the C-05 command set: tenant + site + environment
// provision/archive, as idempotent commands (design §04's own DDL is the domain model; nothing
// here alters it).
import { ConflictException, Injectable, NotFoundException, NotImplementedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { IdempotencyStore } from "../idempotency/idempotency-store";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly idempotency: IdempotencyStore,
    private readonly auditHash: AuditService,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") {
      throw new NotFoundException("tenant not found");
    }
    return tenant;
  }

  // ---------------------------------------------------------------------------
  // Tenant
  // ---------------------------------------------------------------------------

  async provisionTenant(input: { slug: string; companyRef: string; actor: string; idempotencyKey: string }) {
    const args = { slug: input.slug, companyRef: input.companyRef };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `platform:tenant.provision:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      try {
        return await this.db.withPlatformCtx(async (client) => {
          const { rows } = await client.query<{ id: string; slug: string; company_ref: string; status: string; created_at: string }>(
            `INSERT INTO tenants (id, slug, company_ref) VALUES ($1, $2, $3)
             RETURNING id, slug, company_ref, status, created_at`,
            [randomUUID(), input.slug, input.companyRef],
          );
          return rows[0];
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`tenant slug '${input.slug}' already exists — provisioning with a NEW idempotency key does not rename or reuse an existing tenant`);
        }
        throw err;
      }
    });

    await this.commandAudit.recordPlatform({
      command: "tenant.provision",
      actor: input.actor,
      args: { ...args, tenantId: result.id },
      replayed,
    });

    return { tenant: result, replayed };
  }

  async archiveTenant(input: { slug: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    await this.resolveActiveTenant(input.slug);
    const args = { slug: input.slug };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `platform:tenant.archive:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      return this.db.withPlatformCtx(async (client) => {
        const { rows } = await client.query<{ id: string; slug: string; status: string }>(
          `UPDATE tenants SET status = 'archived' WHERE slug = $1 RETURNING id, slug, status`,
          [input.slug],
        );
        if (!rows[0]) throw new NotFoundException("tenant not found");
        return rows[0];
      });
    });

    await this.commandAudit.recordPlatform({
      command: "tenant.archive",
      actor: input.actor,
      args: { ...args, tenantId: result.id },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { tenant: result, replayed };
  }

  // ---------------------------------------------------------------------------
  // Site
  // ---------------------------------------------------------------------------

  async provisionSite(input: { tenantSlug: string; kind: "astro" | "node" | "wp"; name: string; actor: string; idempotencyKey: string }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, kind: input.kind, name: input.name };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:site.provision:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      return this.db.withTenant(tenant.id, (db) =>
        db.transaction(async (client) => {
          const { rows } = await client.query<{ id: string; kind: string; name: string; created_at: string }>(
            `INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, $3, $4)
             RETURNING id, kind, name, created_at`,
            [randomUUID(), tenant.id, input.kind, input.name],
          );
          return rows[0];
        }),
      );
    });

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "site.provision",
      actor: input.actor,
      args: { ...args, siteId: result.id },
      replayed,
    });

    return { site: result, replayed };
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
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:environment.provision:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      try {
        return await this.db.withTenant(tenant.id, (db) =>
          db.transaction(async (client) => {
            const siteCheck = await client.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
            if (!siteCheck.rows[0]) throw new NotFoundException("site not found for this tenant");

            const { rows } = await client.query<{ id: string; name: string; domain: string | null; status: string }>(
              `INSERT INTO environments (id, site_id, tenant_id, name, domain, status)
               VALUES ($1, $2, $3, $4, $5, 'provisioning')
               RETURNING id, name, domain, status`,
              [randomUUID(), input.siteId, tenant.id, input.name, input.domain],
            );
            return rows[0];
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(`environment '${input.name}' already exists for this site — provisioning with a NEW idempotency key does not create a second one (UNIQUE(site_id,name))`);
        }
        throw err;
      }
    });

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "environment.provision",
      actor: input.actor,
      args: { ...args, envId: result.id },
      replayed,
    });

    return { environment: result, replayed };
  }

  async archiveEnvironment(input: { tenantSlug: string; envId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, envId: input.envId };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:environment.archive:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      return this.db.withTenant(tenant.id, (db) =>
        db.transaction(async (client) => {
          const { rows } = await client.query<{ id: string; name: string; status: string }>(
            `UPDATE environments SET status = 'archived' WHERE id = $1 AND tenant_id = $2
             RETURNING id, name, status`,
            [input.envId, tenant.id],
          );
          if (!rows[0]) throw new NotFoundException("environment not found for this tenant");
          return rows[0];
        }),
      );
    });

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "environment.archive",
      actor: input.actor,
      args: { ...args, envId: result.id },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { environment: result, replayed };
  }
}
