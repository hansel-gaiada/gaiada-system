// WSK-21 — the "schema" quarter of the C-05 command set: proposeSchema (draft only, never
// applies — design §05) and applySchema (writes `collections.schema`, the Layer-2
// composition-as-data column 0002_content.sql already defines).
//
// WSK-41 (write-plane design §3.1, finding §14.3) — applySchema used to store ANY JSON object, so a
// malformed composition could break codegen for its tenant and, now, the content write path that
// validates every item against it. It now:
//   1. validates the composition with the vocabulary's own validateCollectionComposition
//      (422 composition-violation, with the validator's issues);
//   2. rates the change with the vocabulary's own tenant-contract classifier
//      (classifyTenantContractChange, vendored from delivery/vocabulary/breaking-change.ts) by
//      diffing the stored composition against the new one for this collection, and returns
//      `{bump, reasons}`;
//   3. REFUSES a `major` change (409 contract-major-change) until WSK-42 governs MAJOR contract
//      changes. A new collection is MINOR ("collection added").
//
// M6-P4r-b: a successful apply queues the tenant's contract codegen after the command commits (the
// envelope's `after` hook, via ContractCodegenTrigger: fail-soft, coalescing, skipped on a replay).
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { CommandEnvelope } from "../command-envelope";
import { assertPlainObject } from "../dto";
import { validateCollectionComposition } from "../../delivery/vocabulary/composition";
import {
  classifyTenantContractChange,
  type ChangeClassification,
  type CollectionFieldSet,
  type TenantContractSnapshot,
} from "../../delivery/vocabulary/breaking-change";
import { ControlProblem } from "../content/content-problem";
import { ContractCodegenTrigger } from "../../codegen/contract-codegen.trigger";
import { isReservedCollectionKey, RESERVED_COLLECTION_KEYS } from "../../delivery/reserved-collection-keys";

/**
 * A stored or proposed `collections.schema` value -> the classifier's per-collection snapshot. The
 * same adaptation as codegen/generator/versioning.mts toContractSnapshot (which this CommonJS file
 * cannot import): fields default to [], and the 1.1.0 keys are carried only when declared. A legacy
 * value that predates validation and is not a composition at all snapshots as an empty collection.
 */
function toCollectionSnapshot(raw: unknown): CollectionFieldSet {
  const c = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const snap: CollectionFieldSet = { fields: Array.isArray(c.fields) ? (c.fields as CollectionFieldSet["fields"]) : [] };
  if (Array.isArray(c.blocks)) snap.blocks = c.blocks as CollectionFieldSet["blocks"];
  if (c.singleton !== undefined) snap.singleton = c.singleton as boolean;
  if (c.localized !== undefined) snap.localized = c.localized as boolean;
  if (c.ui !== undefined) snap.ui = c.ui as CollectionFieldSet["ui"];
  if (c.lint !== undefined) snap.lint = c.lint as CollectionFieldSet["lint"];
  return snap;
}

/** The tenant-contract rating of replacing one collection's composition (`previous` null = new collection). */
export function rateCollectionChange(collectionKey: string, previous: unknown | null, next: unknown): ChangeClassification {
  const before: TenantContractSnapshot = { collections: previous === null ? {} : { [collectionKey]: toCollectionSnapshot(previous) } };
  const after: TenantContractSnapshot = { collections: { [collectionKey]: toCollectionSnapshot(next) } };
  return classifyTenantContractChange(before, after);
}

interface CollectionRow {
  id: string;
  key: string;
  schema: Record<string, unknown>;
  updated_at: string;
}

@Injectable()
export class SchemaService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly envelope: CommandEnvelope,
    private readonly auditHash: AuditService,
    private readonly codegen: ContractCodegenTrigger,
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
    // M3 T1: a key that collides with a static /v1/t/:tenantSlug/<segment> route (media, forms) or a
    // router-owned endpoint (search, sitemap.xml) would create a collection no request can reach.
    // Refused before anything is stored or audited, like the composition refusal below.
    if (isReservedCollectionKey(input.collectionKey)) {
      throw new ControlProblem(
        422,
        "collection-key-reserved",
        "Collection key reserved",
        `"${input.collectionKey}" is reserved: it is a fixed /v1/t/:tenantSlug/ path segment, so a collection with this key could never be served.`,
        { reservedKeys: RESERVED_COLLECTION_KEYS },
      );
    }
    // WSK-41: the composition must be one the vocabulary accepts before anything is stored.
    const validation = validateCollectionComposition(input.collectionKey, schema);
    if (!validation.valid) {
      throw new ControlProblem(422, "composition-violation", "Composition violation", "The schema is not a valid collection composition.", {
        issues: validation.issues,
      });
    }
    const schemaJson = JSON.stringify(schema);
    const commandHash = this.auditHash.hashArgs({
      tenantSlug: input.tenantSlug,
      siteId: input.siteId,
      collectionKey: input.collectionKey,
      schemaJson,
    });

    // M3 T5a: from here on the command is the shared envelope (../command-envelope.ts). The refusals
    // above (tenant, shape, reserved key, composition) run BEFORE it, so they claim no idempotency
    // key and write no audit row. The audit row is now the first statement of the transaction, so it
    // cannot name the collection's id (not known until the upsert); (siteId, collectionKey) is unique
    // (UNIQUE(site_id,key)) and identifies the same row.
    return this.envelope.run<{ collection: CollectionRow; bump: string; reasons: unknown }>({
      command: "schema.apply",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:schema.apply:${input.idempotencyKey}`,
      requestHash: commandHash,
      actor: input.actor,
      auditArgs: { tenantSlug: input.tenantSlug, siteId: input.siteId, collectionKey: input.collectionKey },
      ws4ApprovalId: null,
      effect: async (client) => {
        const siteCheck = await client.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [input.siteId, tenant.id]);
        if (!siteCheck.rows[0]) throw new NotFoundException("site not found for this tenant");

        // WSK-41: rate the change against what is stored now (locked, so two applies cannot both
        // be rated against the same baseline), and refuse MAJOR until WSK-42 governs it.
        const { rows: prevRows } = await client.query<{ schema: unknown }>(
          `SELECT schema FROM collections WHERE site_id = $1 AND key = $2 FOR UPDATE`,
          [input.siteId, input.collectionKey],
        );
        const rating = rateCollectionChange(input.collectionKey, prevRows[0] ? prevRows[0].schema : null, schema);
        if (rating.bump === "major") {
          throw new ControlProblem(
            409,
            "contract-major-change",
            "Contract MAJOR change refused",
            "This schema change is a MAJOR tenant-contract change; MAJOR changes are refused until their governance (WSK-42) exists.",
            { bump: rating.bump, reasons: rating.reasons },
          );
        }

        const { rows } = await client.query<CollectionRow>(
          `INSERT INTO collections (id, tenant_id, site_id, key, schema)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (site_id, key) DO UPDATE SET schema = EXCLUDED.schema, updated_at = now()
           RETURNING id, key, schema, updated_at`,
          [randomUUID(), tenant.id, input.siteId, input.collectionKey, schemaJson],
        );
        return {
          result: { collection: rows[0], bump: rating.bump, reasons: rating.reasons },
          // M6-P4r-b: queue the tenant's contract codegen strictly AFTER the commit. A MAJOR change threw above, so
          // nothing is queued for a refused apply. Fail-soft (the trigger never rejects) and skipped on a replay.
          after: async () => void (await this.codegen.requestRun(input.tenantSlug, "schema.apply")),
        };
      },
    });
  }
}
