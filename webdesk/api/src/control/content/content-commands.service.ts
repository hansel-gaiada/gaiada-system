// WSK-41 — the content authoring commands (write-plane design §2.6, §3; rulings WSK-D45/D46).
//
// STORAGE MODEL (D45). content_versions is the editorial working copy; content_items is the LIVE
// PROJECTION the frozen /v1 read path serves (its SQL is not edited):
//   * draft / unpublished (published_version IS NULL): the projection holds the HEAD version, so a
//     staging key sees the latest draft, exactly as before the write plane existed;
//   * published / scheduled: the projection holds the PUBLISHED version. create/update/restore only
//     append a version and bump head_version; live content is untouched;
//   * publish(v) / schedule(v) is the only path that puts a version in front of a production key.
// `updated_at` moves only when the projection changes, so sitemap lastmod and meta.updatedAt stay
// honest. A pre-0009 row (head_version = 0) is ADOPTED on its first write: version N is written from
// its current projection, and published_version follows its publish_state.
//
// ONE TRANSACTION PER COMMAND, AND THE AUDIT ROW GOES FIRST. The audit row is the FIRST statement of
// the command's transaction, so on a HIGH command the WS4 approval id is CLAIMED (0009's
// ux_audit_entries_ws4_once) BEFORE any side effect. A concurrent second use of the same approval
// blocks on that index until the first commits, then fails with 23505 and rolls back having changed
// nothing (WSK-65's finding: the older commands audit AFTER their effect, so a concurrent reuse 500s
// only after the effect already ran; do not copy that). The idempotency response is stored in the
// same transaction (pg-idempotency-store.ts complete()), so effect, audit and replay record commit
// together or not at all.
//
// AFTER COMMIT, fail-soft: tenant-webhook events (content.published / .unpublished / .scheduled,
// item refs only, never values) and a `content.cache_invalidate` log line with the Cache-Tag set
// (no CDN fronts /v1 yet; WSK-27 wires the purge). Neither can fail or undo a committed command.
//
// Every public method takes an EditorialCommandContext, which holds the EditorialPrincipal that
// EditorialAssertionGuard resolved; audit actor, content_versions.created_by and last_published_by
// are that principal's `sub`, never the control channel's service identity.
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import { AuditService, type AuditArgs } from "../../audit/audit.service";
import { COMMAND_REGISTRY, type CommandName } from "../command-types";
import type { EditorialPrincipal } from "../auth/editorial-principal";
import { computeCommandHash } from "../auth/ws4-assertion";
import { PgIdempotencyStore } from "../idempotency/pg-idempotency-store";
import { TenantWebhookDispatcherService } from "../../tenant-webhooks/tenant-webhook-dispatcher.service";
import type {
  TenantWebhookContentEventKind,
  TenantWebhookContentItemRef,
} from "../../tenant-webhooks/tenant-webhook-event.types";
import { buildCacheTags } from "../../delivery/vocabulary/cache-tags";
import { validateCollectionComposition, type CollectionComposition } from "../../delivery/vocabulary/composition";
import { fieldsBlockOf } from "../../delivery/vocabulary/item-fields";
import {
  assembleItemContent,
  contentHash,
  isPlainObject,
  sizeViolation,
  slugIssue,
  validateStoredContent,
  type ContentInput,
} from "./content-projection";
import { extractSearchText } from "./search-text";
import { lintPlaceholders, type LintReport } from "./content-lint";
import { ControlProblem, problems, type ProblemIssue } from "./content-problem";

// ------------------------------------------------------------------------------------------------
// Public shapes (design §12 WSK-41 signatures, §3.2 JSON)
// ------------------------------------------------------------------------------------------------
export interface EditorialCommandContext {
  tenant: { id: string; slug: string; defaultLocale: string; locales: string[] };
  siteId: string;
  principal: EditorialPrincipal;
  idempotencyKey: string;
  ws4ApprovalId: string | null;
  command: CommandName;
}

export interface CreateItemInput extends ContentInput {
  collectionKey: string;
  locale: string;
  slug: string;
  twinOf: string | null;
  note?: string;
}

export interface UpdateItemInput extends ContentInput {
  baseVersion: number;
  note?: string;
}

export interface ScheduleInput {
  items: { itemId: string; version: number }[];
  publishAt: string | null;
  unpublishAt: string | null;
}

export interface ItemState {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  localizationGroupId: string;
  headVersion: number;
  publishedVersion: number | null;
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
}

export interface VersionRef {
  version: number;
  contentHash: string;
  createdAt: string;
}

export interface ItemWriteResult {
  item: ItemState;
  version: VersionRef;
  unchanged: boolean;
  lint: LintReport;
  replayed: boolean;
}

export interface PublishResult {
  published: { itemId: string; collectionKey: string; locale: string; slug: string; version: number; publishedAt: string }[];
  replayed: boolean;
}

export interface ScheduleResult {
  scheduled: {
    itemId: string;
    collectionKey: string;
    locale: string;
    slug: string;
    version: number;
    publishAt: string | null;
    unpublishAt: string | null;
  }[];
  replayed: boolean;
}

export interface ItemStateResult {
  item: ItemState;
  replayed: boolean;
}

// ------------------------------------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------------------------------------

/**
 * The read path's visibility rule (delivery/content-read.ts EFFECTIVE_PUBLISHED_SQL, restated: that
 * file's SQL is frozen by WSK-48a's byte gate and does not export it). "Live" below means exactly
 * "a production key sees this row right now".
 */
const EFFECTIVE_PUBLISHED_SQL = `(
  (ci.publish_state = 'published' AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
  OR (ci.publish_state = 'scheduled' AND ci.publish_at IS NOT NULL AND ci.publish_at <= now()
      AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
)`;

const ITEM_COLUMNS = `ci.id, ci.collection_id, ci.locale, ci.slug, ci.localization_group_id, ci.head_version,
  ci.published_version, ci.publish_state, ci.publish_at, ci.unpublish_at, ci.deleted_at, ci.updated_at`;

interface ItemRow {
  id: string;
  collection_id: string;
  collection_key: string;
  composition: unknown;
  locale: string;
  slug: string;
  localization_group_id: string;
  head_version: number;
  published_version: number | null;
  publish_state: string;
  publish_at: Date | null;
  unpublish_at: Date | null;
  deleted_at: Date | null;
  updated_at: Date;
  blocks: unknown;
  seo: Record<string, unknown> | null;
  is_live: boolean;
}

interface VersionRow {
  version: number;
  blocks: unknown;
  seo: Record<string, unknown>;
  content_hash: string | null;
  created_at: Date;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function toState(row: Pick<ItemRow, Exclude<keyof ItemRow, "composition" | "blocks" | "seo" | "is_live" | "collection_id">>): ItemState {
  return {
    itemId: row.id,
    collectionKey: row.collection_key,
    locale: row.locale,
    slug: row.slug,
    localizationGroupId: row.localization_group_id,
    headVersion: row.head_version,
    publishedVersion: row.published_version,
    publishState: row.publish_state,
    publishAt: iso(row.publish_at),
    unpublishAt: iso(row.unpublish_at),
    deletedAt: iso(row.deleted_at),
    updatedAt: iso(row.updated_at) as string,
  };
}

function attributionOf(p: EditorialPrincipal): Record<string, string> {
  const a: Record<string, string> = { pk: p.pk };
  if (p.agt) a.agt = p.agt;
  if (p.req) a.req = p.req;
  if (p.apr) a.apr = p.apr;
  return a;
}

function compositionOf(collectionKey: string, raw: unknown): CollectionComposition {
  const v = validateCollectionComposition(collectionKey, raw);
  if (!v.valid) {
    throw problems.compositionViolation(
      v.issues.map((i) => ({ path: `/collection/${i.path}`, message: i.message, ...(i.expected ? { expected: i.expected } : {}) })),
      "The collection's stored composition is itself invalid; apply a valid schema before writing content to it.",
    );
  }
  return raw as CollectionComposition;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Translates the database's own backstops into the documented problems (design §3.4). */
function mapDbError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== "23505") return err;
  switch (e.constraint) {
    case "ux_audit_entries_ws4_once":
      return new ControlProblem(
        403,
        "ws4-approval-already-used",
        "WS4 approval already used",
        "This WS4 approval has already authorised a command; an approval is single-use. Nothing was changed.",
      );
    case "content_items_collection_id_locale_slug_key":
      return problems.conflict("slug-taken", "Slug taken", "An item with this slug already exists in this collection and locale.");
    case "ux_content_items_group_locale":
      return problems.conflict("twin-locale-taken", "Twin locale taken", "The localization group already has a live item in this locale.");
    case "content_versions_content_item_id_version_key":
      return problems.conflict("version-conflict", "Version conflict", "Another write created this version first.");
    default:
      return err;
  }
}

interface EffectOutcome<R> {
  result: R;
  /** Post-commit, fail-soft side effects (webhooks, cache-tag log). */
  after?: () => Promise<void>;
}

@Injectable()
export class ContentCommandsService {
  private readonly logger = new Logger(ContentCommandsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: PgIdempotencyStore,
    private readonly webhooks: TenantWebhookDispatcherService,
  ) {}

  // ==============================================================================================
  // Context
  // ==============================================================================================

  /**
   * Resolves the route's tenant and site. Any miss (unknown or archived tenant, a site of another
   * tenant, a malformed id) is the same 404 site-not-found: no existence oracle across tenants.
   */
  async resolveTenantSite(
    tenantSlug: string,
    siteId: string,
  ): Promise<{ tenant: EditorialCommandContext["tenant"]; siteId: string }> {
    const tenant = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; status: string; default_locale: string; locales: string[] }>(
        `SELECT id, slug, status, default_locale, locales FROM tenants WHERE slug = $1`,
        [tenantSlug],
      );
      return rows[0] ?? null;
    });
    if (!tenant || tenant.status !== "active" || !UUID_RE.test(siteId)) throw problems.siteNotFound();
    const siteExists = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenant.id]);
      return rows.length > 0;
    });
    if (!siteExists) throw problems.siteNotFound();
    return {
      tenant: { id: tenant.id, slug: tenant.slug, defaultLocale: tenant.default_locale, locales: tenant.locales },
      siteId,
    };
  }

  // ==============================================================================================
  // The command envelope: idempotency -> one transaction (audit FIRST, effect, idempotency
  // response) -> post-commit fail-soft side effects.
  // ==============================================================================================
  private async execute<R extends object>(
    ctx: EditorialCommandContext,
    requestArgs: Record<string, unknown>,
    auditArgs: AuditArgs,
    effect: (client: PoolClient) => Promise<EffectOutcome<R>>,
  ): Promise<R & { replayed: boolean }> {
    const meta = COMMAND_REGISTRY[ctx.command];
    const ws4ApprovalId = meta.impactClass === "high" ? ctx.ws4ApprovalId : null;
    if (meta.impactClass === "high" && !ws4ApprovalId) {
      // Defence in depth: CommandAuthorizationGuard already refuses a HIGH command without a
      // verified WS4 assertion; the service never runs one without an approval id to claim.
      throw new ControlProblem(403, "ws4-approval-required", "WS4 approval required", `${ctx.command} is HIGH-impact and needs a WS4 approval.`);
    }

    const requestHash = computeCommandHash(ctx.command, requestArgs);
    const scopeKey = `${ctx.tenant.slug}:${ctx.command}:${ctx.idempotencyKey}`;
    const begin = await this.idempotency.begin<R>({ tenantId: ctx.tenant.id, scopeKey, command: ctx.command, requestHash });

    if (begin.kind === "replay") {
      // A replay changes nothing; it is recorded as such (`.replay` rows are outside the WS4
      // single-use index).
      await this.db
        .withTenant(ctx.tenant.id, (db) =>
          db.transaction((client) =>
            this.audit.record(client, {
              tenantId: ctx.tenant.id,
              actor: ctx.principal.sub,
              action: `control.${ctx.command}.replay`,
              args: auditArgs,
              ws4ApprovalId,
            }),
          ),
        )
        .catch((err) => this.logger.warn(`replay audit row failed for ${ctx.command}: ${String(err)}`));
      return { ...(begin.response as R), replayed: true };
    }

    let after: (() => Promise<void>) | undefined;
    let result: R;
    try {
      result = await this.db.withTenant(ctx.tenant.id, (db) =>
        db.transaction(async (client) => {
          // FIRST statement: claims the WS4 approval id (unique over non-replay rows) before any
          // side effect. A concurrent reuse blocks here, then fails and rolls back untouched.
          await this.audit.record(client, {
            tenantId: ctx.tenant.id,
            actor: ctx.principal.sub,
            action: `control.${ctx.command}`,
            args: auditArgs,
            ws4ApprovalId,
          });
          const outcome = await effect(client);
          after = outcome.after;
          await this.idempotency.complete(client, begin.claim, outcome.result);
          return outcome.result;
        }),
      );
    } catch (err) {
      await this.idempotency.release(begin.claim);
      throw mapDbError(err);
    }

    if (after) {
      await after().catch((err) => this.logger.warn(`post-commit side effect failed for ${ctx.command}: ${String(err)}`));
    }
    return { ...result, replayed: false };
  }

  // ==============================================================================================
  // Shared row operations
  // ==============================================================================================

  /** Locks one item of this site (FOR UPDATE). 404 item-not-found for any miss, including another tenant's id. */
  private async lockItem(client: PoolClient, siteId: string, itemId: string): Promise<ItemRow> {
    if (!UUID_RE.test(itemId)) throw problems.itemNotFound();
    const { rows } = await client.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS}, c.key AS collection_key, c.schema AS composition, ci.blocks, ci.seo,
              ${EFFECTIVE_PUBLISHED_SQL} AS is_live
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE ci.id = $1 AND ci.site_id = $2
        FOR UPDATE OF ci`,
      [itemId, siteId],
    );
    if (!rows[0]) throw problems.itemNotFound();
    return rows[0];
  }

  private async loadVersion(client: PoolClient, itemId: string, version: number): Promise<VersionRow | null> {
    const { rows } = await client.query<VersionRow>(
      `SELECT version, blocks, seo, content_hash, created_at FROM content_versions
        WHERE content_item_id = $1 AND version = $2`,
      [itemId, version],
    );
    return rows[0] ?? null;
  }

  /** The head's ref. A pre-0009 row (head 0) has no version: its projection is its head. */
  private async headRef(client: PoolClient, item: ItemRow): Promise<VersionRef> {
    if (item.head_version === 0) {
      return { version: 0, contentHash: contentHash(item.blocks, item.seo ?? {}), createdAt: iso(item.updated_at) as string };
    }
    const v = await this.loadVersion(client, item.id, item.head_version);
    if (!v) throw new Error(`content item ${item.id} has head_version ${item.head_version} but no such version row`);
    return { version: v.version, contentHash: v.content_hash ?? contentHash(v.blocks, v.seo), createdAt: iso(v.created_at) as string };
  }

  /**
   * First write to a pre-0009 row: writes its current projection as a version and points
   * head_version (and published_version, when the row is published/scheduled) at it. Returns the
   * row with the new pointers. A no-op for any row already on the write plane.
   */
  private async adopt(client: PoolClient, ctx: EditorialCommandContext, item: ItemRow): Promise<ItemRow> {
    if (item.head_version > 0) return item;
    const seo = item.seo ?? {};
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM content_versions WHERE content_item_id = $1`,
      [item.id],
    );
    const v = maxRows[0].next;
    await client.query(
      `INSERT INTO content_versions
         (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by, content_hash, note, attribution)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb)`,
      [
        ctx.tenant.id,
        item.id,
        v,
        JSON.stringify(item.blocks ?? []),
        JSON.stringify(seo),
        item.publish_state,
        ctx.principal.sub,
        contentHash(item.blocks ?? [], seo),
        "adopted: the projection as it stood before the write plane",
        JSON.stringify(attributionOf(ctx.principal)),
      ],
    );
    const isPublishedState = item.publish_state === "published" || item.publish_state === "scheduled";
    await client.query(
      `UPDATE content_items SET head_version = $2, published_version = $3 WHERE id = $1`,
      [item.id, v, isPublishedState ? v : null],
    );
    return { ...item, head_version: v, published_version: isPublishedState ? v : null };
  }

  /**
   * Appends version head+1 and moves head_version. Re-projects ONLY when nothing is published
   * (published_version IS NULL); a live item's projection, and its updated_at, are untouched.
   */
  private async appendVersion(
    client: PoolClient,
    ctx: EditorialCommandContext,
    item: ItemRow,
    blocks: unknown,
    seo: Record<string, unknown>,
    note: string | undefined,
  ): Promise<{ state: ItemState; version: VersionRef }> {
    const v = item.head_version + 1;
    const hash = contentHash(blocks, seo);
    const { rows: vrows } = await client.query<{ created_at: Date }>(
      `INSERT INTO content_versions
         (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by, content_hash, note, attribution)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'draft', $6, $7, $8, $9::jsonb)
       RETURNING created_at`,
      [ctx.tenant.id, item.id, v, JSON.stringify(blocks), JSON.stringify(seo), ctx.principal.sub, hash, note ?? null, JSON.stringify(attributionOf(ctx.principal))],
    );
    const { rows } = await client.query<ItemRow>(
      `UPDATE content_items ci SET
          head_version = $2,
          blocks       = CASE WHEN ci.published_version IS NULL THEN $3::jsonb ELSE ci.blocks END,
          seo          = CASE WHEN ci.published_version IS NULL THEN $4::jsonb ELSE ci.seo END,
          search_text  = CASE WHEN ci.published_version IS NULL THEN $5 ELSE ci.search_text END,
          updated_at   = CASE WHEN ci.published_version IS NULL THEN now() ELSE ci.updated_at END
        WHERE ci.id = $1
        RETURNING ${ITEM_COLUMNS}`,
      [item.id, v, JSON.stringify(blocks), JSON.stringify(seo), extractSearchText(blocks)],
    );
    return {
      state: toState({ ...rows[0], collection_key: item.collection_key }),
      version: { version: v, contentHash: hash, createdAt: iso(vrows[0].created_at) as string },
    };
  }

  /** Advisory lint for `blocks` (never fatal). Loads the token registry when a rule declares one. */
  private async lint(client: PoolClient, ctx: EditorialCommandContext, composition: CollectionComposition, blocks: unknown, locale: string): Promise<LintReport> {
    const rules = composition.lint?.placeholders ?? [];
    if (rules.length === 0) return { placeholders: { unresolvedTokens: [], markers: {} } };
    let registry: Map<string, string | null> | null = null;
    const withRegistry = rules.find((r) => r.kind === "token" && r.registry);
    if (withRegistry && withRegistry.kind === "token" && withRegistry.registry) {
      const reg = withRegistry.registry;
      const { rows } = await client.query<{ blocks: unknown }>(
        `SELECT ci.blocks FROM content_items ci
           JOIN collections c ON c.id = ci.collection_id
          WHERE c.site_id = $1 AND c.key = $2 AND ci.deleted_at IS NULL AND ci.locale IN ($3, $4)
          ORDER BY (ci.locale = $3) DESC, ci.created_at ASC
          LIMIT 1`,
        [ctx.siteId, reg.collection, locale, ctx.tenant.defaultLocale],
      );
      registry = new Map();
      const list = rows[0] ? fieldsBlockOf(rows[0].blocks)?.[reg.listField] : undefined;
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (!isPlainObject(entry) || typeof entry[reg.keyField] !== "string") continue;
          const value = entry[reg.valueField];
          registry.set(entry[reg.keyField] as string, typeof value === "string" ? value : null);
        }
      }
    }
    return lintPlaceholders(rules, blocks, registry);
  }

  private versionConflict(item: ItemRow, head: VersionRef): ControlProblem {
    return problems.conflict(
      "version-conflict",
      "Version conflict",
      `baseVersion does not match the item's head version (${item.head_version}). Reload and re-apply your change.`,
      { currentHeadVersion: item.head_version, currentContentHash: head.contentHash, updatedAt: iso(item.updated_at) },
    );
  }

  private assertNotDeleted(item: ItemRow): void {
    if (item.deleted_at) throw problems.conflict("item-deleted", "Item deleted", "This item has been deleted.");
  }

  /** 422 when there are composition issues, else 413 when over a size cap. */
  private contentChecks(composition: CollectionComposition, blocks: unknown, seo: unknown, issues: ProblemIssue[]): void {
    if (issues.length > 0) throw problems.compositionViolation(issues);
    const tooLarge = sizeViolation(composition, blocks, seo);
    if (tooLarge) throw problems.payloadTooLarge(tooLarge);
  }

  private refOf(state: { itemId: string; collectionKey: string; locale: string; slug: string }, version: number | null): TenantWebhookContentItemRef {
    return { itemId: state.itemId, collectionKey: state.collectionKey, locale: state.locale, slug: state.slug, version };
  }

  /** The post-commit side effects every projection-changing command shares. */
  private announce(
    ctx: EditorialCommandContext,
    kind: TenantWebhookContentEventKind,
    refs: TenantWebhookContentItemRef[],
    extra?: { publishAt?: string | null; unpublishAt?: string | null },
  ): () => Promise<void> {
    return async () => {
      const tags = new Set<string>();
      for (const r of refs) {
        for (const t of buildCacheTags({ tenantSlug: ctx.tenant.slug, collectionKey: r.collectionKey, itemId: r.itemId })) tags.add(t);
      }
      this.logger.log(JSON.stringify({ event: "content.cache_invalidate", command: ctx.command, tenant: ctx.tenant.slug, tags: [...tags] }));
      await this.webhooks.dispatchContentEvent(ctx.tenant.id, kind, { siteId: ctx.siteId, items: refs, ...(extra ?? {}) });
    };
  }

  // ==============================================================================================
  // content.create
  // ==============================================================================================
  async createItem(ctx: EditorialCommandContext, input: CreateItemInput): Promise<ItemWriteResult> {
    const itemId = randomUUID();
    return this.execute<Omit<ItemWriteResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, collectionKey: input.collectionKey, locale: input.locale, slug: input.slug },
      async (client) => {
        const { rows: colRows } = await client.query<{ id: string; key: string; schema: unknown }>(
          // Locked: serialises creates in one collection, which is what makes the singleton rule hold.
          `SELECT id, key, schema FROM collections WHERE site_id = $1 AND key = $2 FOR UPDATE`,
          [ctx.siteId, input.collectionKey],
        );
        const col = colRows[0];
        if (!col) throw problems.collectionNotFound();
        const composition = compositionOf(col.key, col.schema);

        // -- composition-level validation (422) --------------------------------------------------
        const issues: ProblemIssue[] = [];
        const sIssue = slugIssue(col.key, input.slug);
        if (sIssue) issues.push(sIssue);
        if (!ctx.tenant.locales.includes(input.locale)) {
          issues.push({ path: "/locale", message: "the locale is not one of the tenant's declared locales", expected: ctx.tenant.locales.join(" | ") });
        } else if ((composition.localized === false || col.key === "redirect") && input.locale !== ctx.tenant.defaultLocale) {
          issues.push({ path: "/locale", message: "this collection is not localized: items exist only in the tenant's default locale", expected: ctx.tenant.defaultLocale });
        }
        const assembled = assembleItemContent(col.key, composition, input);
        issues.push(...assembled.issues);
        this.contentChecks(composition, assembled.blocks, assembled.seo, issues);

        // -- state (409) --------------------------------------------------------------------------
        if (composition.singleton) {
          const { rows } = await client.query(
            `SELECT 1 FROM content_items WHERE collection_id = $1 AND locale = $2 AND deleted_at IS NULL LIMIT 1`,
            [col.id, input.locale],
          );
          if (rows.length > 0) {
            throw problems.conflict("singleton-exists", "Singleton exists", "This collection is a singleton and already has an item in this locale.");
          }
        }
        const { rows: slugRows } = await client.query(
          `SELECT 1 FROM content_items WHERE collection_id = $1 AND locale = $2 AND slug = $3`,
          [col.id, input.locale, input.slug],
        );
        if (slugRows.length > 0) {
          throw problems.conflict("slug-taken", "Slug taken", "An item with this slug already exists in this collection and locale.");
        }
        let groupId: string | null = null;
        if (input.twinOf) {
          const { rows: twinRows } = await client.query<{ collection_id: string; localization_group_id: string; deleted_at: Date | null }>(
            `SELECT collection_id, localization_group_id, deleted_at FROM content_items WHERE id = $1 AND site_id = $2 FOR UPDATE`,
            [input.twinOf, ctx.siteId],
          );
          const twin = twinRows[0];
          if (!twin || twin.deleted_at) throw problems.itemNotFound();
          if (twin.collection_id !== col.id) {
            throw problems.compositionViolation([{ path: "/twinOf", message: "twinOf must name an item in the same collection" }]);
          }
          const { rows: taken } = await client.query(
            `SELECT 1 FROM content_items WHERE site_id = $1 AND localization_group_id = $2 AND locale = $3 AND deleted_at IS NULL`,
            [ctx.siteId, twin.localization_group_id, input.locale],
          );
          if (taken.length > 0) {
            throw problems.conflict("twin-locale-taken", "Twin locale taken", "The twin's localization group already has an item in this locale.");
          }
          groupId = twin.localization_group_id;
        }

        // -- effect --------------------------------------------------------------------------------
        const hash = contentHash(assembled.blocks, assembled.seo);
        const { rows } = await client.query<ItemRow>(
          `INSERT INTO content_items AS ci
             (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
              publish_state, search_text, head_version)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::uuid, gen_random_uuid()), $8::jsonb, $9::jsonb, 'draft', $10, 1)
           RETURNING ${ITEM_COLUMNS}`,
          [itemId, ctx.tenant.id, ctx.siteId, col.id, input.locale, input.slug, groupId, JSON.stringify(assembled.blocks), JSON.stringify(assembled.seo), extractSearchText(assembled.blocks)],
        );
        const { rows: vrows } = await client.query<{ created_at: Date }>(
          `INSERT INTO content_versions
             (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by, content_hash, note, attribution)
           VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, 'draft', $5, $6, $7, $8::jsonb)
           RETURNING created_at`,
          [ctx.tenant.id, itemId, JSON.stringify(assembled.blocks), JSON.stringify(assembled.seo), ctx.principal.sub, hash, input.note ?? null, JSON.stringify(attributionOf(ctx.principal))],
        );
        const lint = await this.lint(client, ctx, composition, assembled.blocks, input.locale);
        return {
          result: {
            item: toState({ ...rows[0], collection_key: col.key }),
            version: { version: 1, contentHash: hash, createdAt: iso(vrows[0].created_at) as string },
            unchanged: false,
            lint,
          },
        };
      },
    );
  }

  // ==============================================================================================
  // content.update / content.restoreVersion — both append a version from a full {blocks, seo}
  // ==============================================================================================
  async updateItem(ctx: EditorialCommandContext, itemId: string, input: UpdateItemInput): Promise<ItemWriteResult> {
    return this.execute<Omit<ItemWriteResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, baseVersion: input.baseVersion },
      async (client) => {
        const item = await this.lockItem(client, ctx.siteId, itemId);
        this.assertNotDeleted(item);
        const composition = compositionOf(item.collection_key, item.composition);
        const assembled = assembleItemContent(item.collection_key, composition, input);
        this.contentChecks(composition, assembled.blocks, assembled.seo, assembled.issues);
        return { result: await this.writeFromContent(client, ctx, item, composition, input.baseVersion, assembled.blocks, assembled.seo, input.note) };
      },
    );
  }

  async restoreVersion(
    ctx: EditorialCommandContext,
    itemId: string,
    input: { version: number; baseVersion: number; note?: string },
  ): Promise<ItemWriteResult> {
    return this.execute<Omit<ItemWriteResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, version: input.version, baseVersion: input.baseVersion },
      async (client) => {
        const item = await this.lockItem(client, ctx.siteId, itemId);
        this.assertNotDeleted(item);
        const source = await this.loadVersion(client, item.id, input.version);
        if (!source) throw problems.conflict("version-not-found", "Version not found", `Version ${input.version} does not exist for this item.`);
        const composition = compositionOf(item.collection_key, item.composition);
        // Valid when it was written is not valid now if the composition changed since: re-check.
        const issues = validateStoredContent(item.collection_key, composition, source.blocks, source.seo);
        this.contentChecks(composition, source.blocks, source.seo, issues);
        return { result: await this.writeFromContent(client, ctx, item, composition, input.baseVersion, source.blocks, source.seo, input.note) };
      },
    );
  }

  private async writeFromContent(
    client: PoolClient,
    ctx: EditorialCommandContext,
    item: ItemRow,
    composition: CollectionComposition,
    baseVersion: number,
    blocks: unknown,
    seo: Record<string, unknown>,
    note: string | undefined,
  ): Promise<Omit<ItemWriteResult, "replayed">> {
    const head = await this.headRef(client, item);
    if (baseVersion !== item.head_version) throw this.versionConflict(item, head);
    const lint = await this.lint(client, ctx, composition, blocks, item.locale);
    if (contentHash(blocks, seo) === head.contentHash) {
      // No change: no version is written, nothing moves (design §3.2 `unchanged`).
      return { item: toState(item), version: head, unchanged: true, lint };
    }
    const adopted = await this.adopt(client, ctx, item);
    const { state, version } = await this.appendVersion(client, ctx, adopted, blocks, seo, note);
    return { item: state, version, unchanged: false, lint };
  }

  // ==============================================================================================
  // content.publish (HIGH)
  // ==============================================================================================
  async publish(
    ctx: EditorialCommandContext,
    input: { items: { itemId: string; version: number }[]; note?: string },
  ): Promise<PublishResult> {
    return this.execute<Omit<PublishResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, ...input },
      {
        tenantSlug: ctx.tenant.slug,
        siteId: ctx.siteId,
        itemCount: input.items.length,
        itemsHash: computeCommandHash("content.publish.items", input.items),
      },
      async (client) => {
        const rows = await this.lockAll(client, ctx.siteId, input.items.map((i) => i.itemId));
        const published: PublishResult["published"] = [];
        const refs: TenantWebhookContentItemRef[] = [];
        for (const [index, req] of input.items.entries()) {
          let item = rows.get(req.itemId) as ItemRow;
          this.assertNotDeleted(item);
          const source = await this.loadVersion(client, item.id, req.version);
          if (!source) {
            throw problems.conflict("version-not-found", "Version not found", `Item ${item.id} has no version ${req.version}.`, { itemIndex: index });
          }
          const composition = compositionOf(item.collection_key, item.composition);
          const issues = validateStoredContent(item.collection_key, composition, source.blocks, source.seo).map((i) => ({
            ...i,
            path: `/items/${index}${i.path}`,
          }));
          if (issues.length > 0) throw problems.compositionViolation(issues, "A version to publish no longer satisfies its collection's composition.");

          const alreadyLive = item.published_version === req.version && item.publish_state === "published" && item.publish_at === null && item.is_live;
          let publishedAt: string;
          if (alreadyLive) {
            publishedAt = iso((await client.query<{ at: Date }>(`SELECT COALESCE(last_published_at, updated_at) AS at FROM content_items WHERE id = $1`, [item.id])).rows[0].at) as string;
          } else {
            item = await this.adopt(client, ctx, item);
            const { rows: upd } = await client.query<{ last_published_at: Date }>(
              `UPDATE content_items SET
                  blocks = $2::jsonb, seo = $3::jsonb, search_text = $4,
                  published_version = $5, publish_state = 'published', publish_at = NULL,
                  unpublish_at = CASE WHEN unpublish_at > now() THEN unpublish_at ELSE NULL END,
                  last_published_at = now(), last_published_by = $6, updated_at = now()
                WHERE id = $1
                RETURNING last_published_at`,
              [item.id, JSON.stringify(source.blocks), JSON.stringify(source.seo), extractSearchText(source.blocks), req.version, ctx.principal.sub],
            );
            publishedAt = iso(upd[0].last_published_at) as string;
          }
          published.push({ itemId: item.id, collectionKey: item.collection_key, locale: item.locale, slug: item.slug, version: req.version, publishedAt });
          refs.push({ itemId: item.id, collectionKey: item.collection_key, locale: item.locale, slug: item.slug, version: req.version });
        }
        return { result: { published }, after: this.announce(ctx, "content.published", refs) };
      },
    );
  }

  /** Locks every item in a stable (id) order so two batches can never deadlock; 404 on any miss. */
  private async lockAll(client: PoolClient, siteId: string, itemIds: string[]): Promise<Map<string, ItemRow>> {
    const out = new Map<string, ItemRow>();
    for (const id of [...itemIds].sort()) out.set(id, await this.lockItem(client, siteId, id));
    return out;
  }

  // ==============================================================================================
  // content.schedule (HIGH)
  // ==============================================================================================
  async schedule(ctx: EditorialCommandContext, input: ScheduleInput): Promise<ScheduleResult> {
    return this.execute<Omit<ScheduleResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, ...input },
      {
        tenantSlug: ctx.tenant.slug,
        siteId: ctx.siteId,
        itemCount: input.items.length,
        itemsHash: computeCommandHash("content.schedule.items", input.items),
        publishAt: input.publishAt,
        unpublishAt: input.unpublishAt,
      },
      async (client) => {
        const rows = await this.lockAll(client, ctx.siteId, input.items.map((i) => i.itemId));
        const scheduled: ScheduleResult["scheduled"] = [];
        const refs: TenantWebhookContentItemRef[] = [];
        for (const [index, req] of input.items.entries()) {
          let item = rows.get(req.itemId) as ItemRow;
          this.assertNotDeleted(item);
          if (input.publishAt !== null) {
            // A deferred publish. Moving a LIVE item's content at a future time needs the worker
            // that swaps the projection then (WSK-61); until it exists that is refused.
            if (item.is_live) {
              throw problems.conflict(
                "schedule-live-item-requires-worker",
                "Scheduling a live item needs the scheduler",
                "This item is live; scheduling a different version of a live item needs the publish worker (WSK-61). Publish it, or schedule a takedown.",
                { itemIndex: index },
              );
            }
            const source = await this.loadVersion(client, item.id, req.version);
            if (!source) {
              throw problems.conflict("version-not-found", "Version not found", `Item ${item.id} has no version ${req.version}.`, { itemIndex: index });
            }
            const composition = compositionOf(item.collection_key, item.composition);
            const issues = validateStoredContent(item.collection_key, composition, source.blocks, source.seo).map((i) => ({
              ...i,
              path: `/items/${index}${i.path}`,
            }));
            if (issues.length > 0) throw problems.compositionViolation(issues, "A version to schedule no longer satisfies its collection's composition.");
            item = await this.adopt(client, ctx, item);
            // The projection takes the scheduled version now; the read path's time rule keeps it
            // invisible to production until publish_at (and honours unpublish_at).
            await client.query(
              `UPDATE content_items SET
                  blocks = $2::jsonb, seo = $3::jsonb, search_text = $4,
                  published_version = $5, publish_state = 'scheduled', publish_at = $6, unpublish_at = $7,
                  last_published_at = $6, last_published_by = $8, updated_at = now()
                WHERE id = $1`,
              [item.id, JSON.stringify(source.blocks), JSON.stringify(source.seo), extractSearchText(source.blocks), req.version, input.publishAt, input.unpublishAt, ctx.principal.sub],
            );
          } else {
            // A scheduled takedown of the live version.
            if (!item.is_live) {
              throw problems.conflict("not-live", "Not live", "A scheduled takedown needs a live item.", { itemIndex: index });
            }
            item = await this.adopt(client, ctx, item);
            if (item.published_version !== req.version) {
              throw problems.conflict(
                "published-version-changed",
                "Published version changed",
                `The live version is ${item.published_version}, not ${req.version}.`,
                { itemIndex: index, currentPublishedVersion: item.published_version },
              );
            }
            await client.query(`UPDATE content_items SET unpublish_at = $2 WHERE id = $1`, [item.id, input.unpublishAt]);
          }
          scheduled.push({
            itemId: item.id,
            collectionKey: item.collection_key,
            locale: item.locale,
            slug: item.slug,
            version: req.version,
            publishAt: input.publishAt,
            unpublishAt: input.unpublishAt,
          });
          refs.push({ itemId: item.id, collectionKey: item.collection_key, locale: item.locale, slug: item.slug, version: req.version });
        }
        return {
          result: { scheduled },
          after: this.announce(ctx, "content.scheduled", refs, { publishAt: input.publishAt, unpublishAt: input.unpublishAt }),
        };
      },
    );
  }

  // ==============================================================================================
  // content.unpublish (MEDIUM) — a takedown never waits for a second person (D46)
  // ==============================================================================================
  async unpublish(ctx: EditorialCommandContext, itemId: string, input: { expectedPublishedVersion: number }): Promise<ItemStateResult> {
    return this.execute<Omit<ItemStateResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, expectedPublishedVersion: input.expectedPublishedVersion },
      async (client) => {
        let item = await this.lockItem(client, ctx.siteId, itemId);
        this.assertNotDeleted(item);
        item = await this.adopt(client, ctx, item);
        if (item.published_version === null) throw problems.conflict("not-live", "Not live", "This item is not published.");
        if (item.published_version !== input.expectedPublishedVersion) {
          throw problems.conflict(
            "published-version-changed",
            "Published version changed",
            `The published version is ${item.published_version}, not ${input.expectedPublishedVersion}.`,
            { currentPublishedVersion: item.published_version },
          );
        }
        const head = await this.loadVersion(client, item.id, item.head_version);
        if (!head) throw new Error(`content item ${item.id} has head_version ${item.head_version} but no such version row`);
        // Back to the draft model: the projection serves the head again (staging sees it,
        // production does not).
        const { rows } = await client.query<ItemRow>(
          `UPDATE content_items ci SET
              publish_state = 'unpublished', published_version = NULL, publish_at = NULL, unpublish_at = NULL,
              blocks = $2::jsonb, seo = $3::jsonb, search_text = $4, updated_at = now()
            WHERE ci.id = $1
            RETURNING ${ITEM_COLUMNS}`,
          [item.id, JSON.stringify(head.blocks), JSON.stringify(head.seo), extractSearchText(head.blocks)],
        );
        const state = toState({ ...rows[0], collection_key: item.collection_key });
        return {
          result: { item: state },
          after: this.announce(ctx, "content.unpublished", [this.refOf(state, input.expectedPublishedVersion)]),
        };
      },
    );
  }

  // ==============================================================================================
  // content.delete (MEDIUM) — a SOFT delete of a non-live item; history is kept
  // ==============================================================================================
  async deleteItem(ctx: EditorialCommandContext, itemId: string, input: { baseVersion: number }): Promise<ItemStateResult> {
    return this.execute<Omit<ItemStateResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, baseVersion: input.baseVersion },
      async (client) => {
        const item = await this.lockItem(client, ctx.siteId, itemId);
        this.assertNotDeleted(item);
        const liveLike =
          item.published_version !== null ||
          (item.head_version === 0 && (item.publish_state === "published" || item.publish_state === "scheduled"));
        if (liveLike) {
          throw problems.conflict("item-is-live", "Item is live", "A published or scheduled item cannot be deleted; unpublish it first.");
        }
        if (input.baseVersion !== item.head_version) throw this.versionConflict(item, await this.headRef(client, item));
        const { rows } = await client.query<ItemRow>(
          `UPDATE content_items ci SET deleted_at = now() WHERE ci.id = $1 RETURNING ${ITEM_COLUMNS}`,
          [item.id],
        );
        return { result: { item: toState({ ...rows[0], collection_key: item.collection_key }) } };
      },
    );
  }
}
