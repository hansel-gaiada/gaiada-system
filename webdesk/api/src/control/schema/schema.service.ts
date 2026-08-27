// WSK-21 — the "schema" quarter of the C-05 command set: proposeSchema (draft only, never
// applies — design §05) and applySchema (writes `collections.schema`, the Layer-2
// composition-as-data column 0002_content.sql already defines).
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { IdempotencyStore } from "../idempotency/idempotency-store";
import { assertPlainObject } from "../dto";

@Injectable()
export class SchemaService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly idempotency: IdempotencyStore,
    private readonly auditHash: AuditService,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    return tenant;
  }

  /**
   * DRAFT ONLY — never persisted (design §05: "proposeSchema (draft only, never applies)").
   * WSK-14's vocabulary composition validator does not exist yet, so this performs only the
   * structural check it can honestly make (valid JSON object) plus a shallow key diff against
   * the collection's CURRENT schema, if the collection already exists. Real vocabulary-rule
   * validation (primitives/block types/breaking-change classification per §05's versioning
   * table) is WSK-14's build; `validation.notes` says so explicitly rather than pretending to a
   * rule set that is not implemented. Read-only (impact class `read` in COMMAND_REGISTRY) — no
   * idempotency key needed, nothing to replay-protect.
   */
  async proposeSchema(input: { tenantSlug: string; siteId: string; collectionKey: string; proposedSchema: unknown; actor: string }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const proposed = assertPlainObject(input.proposedSchema, "proposedSchema");

    const current = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query<{ schema: Record<string, unknown> }>(
        `SELECT schema FROM collections WHERE tenant_id = $1 AND site_id = $2 AND key = $3`,
        [tenant.id, input.siteId, input.collectionKey],
      );
      return rows[0]?.schema ?? null;
    });

    const addedKeys = Object.keys(proposed).filter((k) => !current || !(k in current));
    const removedKeys = current ? Object.keys(current).filter((k) => !(k in proposed)) : [];

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "schema.propose",
      actor: input.actor,
      args: { tenantSlug: input.tenantSlug, siteId: input.siteId, collectionKey: input.collectionKey },
    });

    return {
      collectionKey: input.collectionKey,
      currentSchema: current,
      proposedSchema: proposed,
      diff: { addedKeys, removedKeys },
      validation: {
        structurallyValid: true,
        notes:
          "Structural check only (valid JSON object + shallow key diff). Vocabulary/breaking-change " +
          "rules (design §05) are WSK-14's composition validator, not yet built — do not treat this as a " +
          "vocabulary-conformance pass.",
      },
      persisted: false,
    };
  }

  /** Writes `collections.schema` (upsert by the table's own UNIQUE(site_id,key)) — a real, idempotent-by-nature domain effect, wrapped in the caller-supplied idempotency key for the "same call twice" case. */
  async applySchema(input: { tenantSlug: string; siteId: string; collectionKey: string; schema: unknown; actor: string; idempotencyKey: string }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const schema = assertPlainObject(input.schema, "schema");
    const schemaJson = JSON.stringify(schema);
    const commandHash = this.auditHash.hashArgs({
      tenantSlug: input.tenantSlug,
      siteId: input.siteId,
      collectionKey: input.collectionKey,
      schemaJson,
    });
    const scopeKey = `${input.tenantSlug}:schema.apply:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      return this.db.withTenant(tenant.id, (db) =>
        db.transaction(async (client) => {
          const siteCheck = await client.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
          if (!siteCheck.rows[0]) throw new NotFoundException("site not found for this tenant");

          const { rows } = await client.query<{ id: string; key: string; schema: Record<string, unknown>; updated_at: string }>(
            `INSERT INTO collections (id, tenant_id, site_id, key, schema)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (site_id, key) DO UPDATE SET schema = EXCLUDED.schema, updated_at = now()
             RETURNING id, key, schema, updated_at`,
            [randomUUID(), tenant.id, input.siteId, input.collectionKey, schemaJson],
          );
          return rows[0];
        }),
      );
    });

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "schema.apply",
      actor: input.actor,
      args: { tenantSlug: input.tenantSlug, siteId: input.siteId, collectionKey: input.collectionKey, collectionId: result.id },
      replayed,
    });

    return { collection: result, replayed };
  }
}
