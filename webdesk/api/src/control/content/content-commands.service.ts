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
// ONE TRANSACTION PER COMMAND, AND THE AUDIT ROW GOES FIRST (the shared CommandEnvelope, ../command-envelope.ts,
// runs it; M3 T8 replaced this file's private copy of that logic). The audit row is the FIRST statement of
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
// (no CDN fronts /v1 yet; WSK-70 wires the purge, WSK-D50). Neither can fail or undo a committed command.
//
// Every public method takes an EditorialCommandContext, which holds the EditorialPrincipal that
// EditorialAssertionGuard resolved; audit actor, content_versions.created_by and last_published_by
// are that principal's `sub`, never the control channel's service identity.
//
// CLIENT EDITORS (WSK-49b, ruling WSK-D59). A principal whose signed assertion carries `ce: true` is held to
// two more checks, and ONLY that principal: without the marker every line added for WSK-49 is a no-op.
//   * commands: assertClientMayRun (../auth/client-editor.ts) at the top of every public method, on top of
//     the guard's own call: a client may not delete, unpublish or schedule (media.delete is the media
//     service's).
//   * paths: create / update / restoreVersion compute which paths of the item's content the write changes
//     (create: against a blank item; update and restore: against the item's HEAD version) and refuse the
//     WHOLE write with 422 field-not-client-editable, listing the JSON pointers, unless every one is
//     client-editable under the vocabulary's one rule (delivery/vocabulary/client-editable.ts). The check
//     runs BEFORE content validation, so an unauthorised change is never answered as an ordinary 422 about
//     something else, and inside the command's transaction, so a refusal writes nothing (not even an audit
//     row: the envelope rolls back).
//   * publish (WSK-D62): a client may publish only what a client could have changed. Every item's published
//     version (empty when never published) is diffed against the version being published, and every changed
//     path must be client-editable, else 422 publish-not-client-editable for the whole batch.
//
// THE REVIEW GATE (M5-W2c, writers' room design 4.5). On a collection whose editorial policy has review ON, publish
// and schedule (a schedule that publishes) refuse any version that is not EXACTLY the approved one: 409
// review-not-approved for the whole batch, for every principal class. It runs inside the transaction, after the WS4
// claim and D62's client check and before any effect, so a refusal rolls the claim back with everything else. Review
// OFF (the default) is a no-op. See ../editorial/review-gate.ts for the rule and why it is the version, not the head.
//
// THE EXPERIMENT LOCK (M5-V5-a, vocabulary 1.5.0, phase-5 design 5.1). An item whose LIVE version carries an
// `experiment` block has a RUNNING A/B test (the test starts when the version carrying the block is published, so
// the live version IS the running state: this guard needs no ERP flag). Publishing (or scheduling a publish of) a
// version that changes that experiment, or the control values it overrides, is refused 409 experiment-locked for
// every principal class, for the whole batch, inside the transaction and before any effect. Dropping the block (the
// stop) is always allowed. The comparison is the vocabulary's own (experimentLockViolations, item-fields.ts).
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import type { AuditArgs } from "../../audit/audit.service";
import type { CommandName } from "../command-types";
import { CommandEnvelope, type EffectOutcome } from "../command-envelope";
import type { EditorialPrincipal } from "../auth/editorial-principal";
import { computeCommandHash } from "../auth/ws4-assertion";
import { TenantWebhookDispatcherService } from "../../tenant-webhooks/tenant-webhook-dispatcher.service";
import type {
  TenantWebhookContentEventKind,
  TenantWebhookContentItemRef,
} from "../../tenant-webhooks/tenant-webhook-event.types";
import { validateCollectionComposition, type CollectionComposition } from "../../delivery/vocabulary/composition";
import { experimentLockViolations, fieldsBlockOf, type ExperimentLockViolation } from "../../delivery/vocabulary/item-fields";
import { clientCreateViolations, clientEditViolations, collectionAcceptsClientCreate } from "../../delivery/vocabulary/client-editable";
import { assertClientMayRun, fieldNotClientEditable, isClientEditor, publishNotClientEditable } from "../auth/client-editor";
import {
  assembleItemContent,
  contentHash,
  fieldsCarrierFor,
  isPlainObject,
  sizeViolation,
  slugIssue,
  validateStoredContent,
  type ContentInput,
} from "./content-projection";
import { extractSearchText } from "./search-text";
import { attributionOf, insertContentVersion } from "./content-versions";
// M5-W2b: the review flow follows the version writer (an edit in review / after approval), see editorial-store.ts.
import { onItemCreated, onVersionAppended } from "../editorial/editorial-store";
// M5-W2c: the publish gate, the exact approved version on a review-required collection (review-gate.ts).
import { assertReviewApproved, type GateItem } from "../editorial/review-gate";
import {
  ITEM_COLUMNS,
  adoptLegacyItem,
  announceContentEvent,
  applyPublishEffect,
  applyUnpublishEffect,
  cancelPendingSwap,
  effectivePublishedSql,
  loadVersionRow,
  type ItemColumnsRow,
  type VersionRow,
} from "./content-transitions";
import { computeContentLint, lintPlaceholders, type ContentLintReport, type LintReport } from "./content-lint";
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
 * "Live" below means exactly "a production key sees this row right now" (the read path's visibility
 * rule; content-transitions.ts restates it, parameterised on the clock so the scheduler can share it).
 */
const EFFECTIVE_PUBLISHED_SQL = effectivePublishedSql("now()");

interface ItemRow extends ItemColumnsRow {
  collection_key: string;
  composition: unknown;
  blocks: unknown;
  seo: Record<string, unknown> | null;
  is_live: boolean;
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

/**
 * Translates the database's own backstops into the documented problems (design §3.4). Exported so a
 * spec can pin the constraint names: 0010 (WSK-D51) replaced the table-wide UNIQUE
 * `content_items_collection_id_locale_slug_key` with the partial unique index
 * `ux_content_items_slug_live` (live rows only), so only the new name can ever arrive here.
 */
export function mapDbError(err: unknown): unknown {
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
    case "ux_content_items_slug_live":
      return problems.conflict("slug-taken", "Slug taken", "An item with this slug already exists in this collection and locale.");
    case "ux_content_items_group_locale":
      return problems.conflict("twin-locale-taken", "Twin locale taken", "The localization group already has a live item in this locale.");
    case "content_versions_content_item_id_version_key":
      return problems.conflict("version-conflict", "Version conflict", "Another write created this version first.");
    default:
      return err;
  }
}

@Injectable()
export class ContentCommandsService {
  private readonly logger = new Logger(ContentCommandsService.name);

  constructor(
    private readonly db: DbService,
    private readonly envelope: CommandEnvelope,
    private readonly webhooks: TenantWebhookDispatcherService,
  ) {}

  // ==============================================================================================
  // Context
  // ==============================================================================================

  /**
   * Resolves the route's tenant and site. Any miss (unknown or archived tenant, a site of another
   * tenant, a malformed id) is the same 404 site-not-found: no existence oracle across tenants. A site of
   * this tenant that was ARCHIVED (site.archive) is a 409 site-archived: the caller is authenticated and
   * already scoped to the tenant, so naming the state leaks nothing and tells staff why.
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
    const siteStatus = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query<{ status: string }>(`SELECT status FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenant.id]);
      return rows[0]?.status ?? null;
    });
    if (siteStatus === null) throw problems.siteNotFound();
    // site.archive: the site-scope mirror of the archived-tenant refusal above. Every content, media, editorial
    // and forms-definition route resolves its site here, so this one line closes them all.
    if (siteStatus !== "active") throw problems.siteArchived();
    return {
      tenant: { id: tenant.id, slug: tenant.slug, defaultLocale: tenant.default_locale, locales: tenant.locales },
      siteId,
    };
  }

  // ==============================================================================================
  // The command envelope (../command-envelope.ts): idempotency -> one transaction (audit FIRST, effect,
  // idempotency response) -> post-commit fail-soft side effects. This adapter only names the command's
  // scope and keys; mapDbError turns the content constraint names into their problems.
  // ==============================================================================================
  private execute<R extends object>(
    ctx: EditorialCommandContext,
    requestArgs: Record<string, unknown>,
    auditArgs: AuditArgs,
    effect: (client: PoolClient) => Promise<EffectOutcome<R>>,
  ): Promise<R & { replayed: boolean }> {
    // WSK-49b: a client's request never shares an idempotency record with a staff request of the same key and
    // body (a replay would otherwise hand a client the stored result of a write it was not allowed to make),
    // and its audit row says so. Both are untouched for every other principal.
    const client = isClientEditor(ctx.principal);
    return this.envelope.run<R>({
      command: ctx.command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${ctx.command}:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash(ctx.command, client ? { ...requestArgs, __clientEditor: true } : requestArgs),
      actor: ctx.principal.sub,
      auditArgs: client ? { ...auditArgs, clientEditor: true } : auditArgs,
      ws4ApprovalId: ctx.ws4ApprovalId,
      effect,
      mapError: mapDbError,
    });
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

  private loadVersion(client: PoolClient, itemId: string, version: number): Promise<VersionRow | null> {
    return loadVersionRow(client, itemId, version);
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
  private adopt(client: PoolClient, ctx: EditorialCommandContext, item: ItemRow): Promise<ItemRow> {
    return adoptLegacyItem(client, { tenantId: ctx.tenant.id, createdBy: ctx.principal.sub, attribution: attributionOf(ctx.principal) }, item);
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
    const stored = await insertContentVersion(client, {
      tenantId: ctx.tenant.id,
      itemId: item.id,
      version: v,
      blocks,
      seo,
      publishState: "draft",
      createdBy: ctx.principal.sub,
      note: note ?? null,
      attribution: attributionOf(ctx.principal),
    });
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
    // M5-W2b: in_review follows the new head, approved returns to draft; a no-op for an item with no review row.
    await onVersionAppended(client, { tenantId: ctx.tenant.id, itemId: item.id, version: v, actor: ctx.principal.sub });
    return {
      state: toState({ ...rows[0], collection_key: item.collection_key }),
      version: { version: v, contentHash: stored.contentHash, createdAt: iso(stored.createdAt) as string },
    };
  }

  /**
   * Advisory lint (never fatal): the placeholder lint plus, additively, the M5-W3 content checks as
   * `content`. The content checks can only degrade (to `unavailable`), never throw into the save.
   */
  private async lint(
    client: PoolClient,
    ctx: EditorialCommandContext,
    composition: CollectionComposition,
    blocks: unknown,
    locale: string,
    seo: unknown,
    groupId: string,
  ): Promise<LintReport> {
    const report = await this.placeholderLint(client, ctx, composition, blocks, locale);
    const content = await this.contentLint(client, ctx, composition, blocks, locale, seo, groupId);
    return content ? { ...report, content } : report;
  }

  private async contentLint(
    client: PoolClient,
    ctx: EditorialCommandContext,
    composition: CollectionComposition,
    blocks: unknown,
    locale: string,
    seo: unknown,
    groupId: string,
  ): Promise<ContentLintReport | undefined> {
    return computeContentLint(client, ctx.siteId, groupId, { blocks, seo, composition, locale });
  }

  /** Advisory placeholder lint for `blocks`. Loads the token registry when a rule declares one. */
  private async placeholderLint(client: PoolClient, ctx: EditorialCommandContext, composition: CollectionComposition, blocks: unknown, locale: string): Promise<LintReport> {
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

  /** The item's HEAD content as a version holds it. A pre-0009 row (head 0) has no version: its projection is its head. */
  private async headContent(client: PoolClient, item: ItemRow): Promise<{ blocks: unknown; seo: unknown }> {
    if (item.head_version === 0) return { blocks: item.blocks, seo: item.seo ?? {} };
    const v = await this.loadVersion(client, item.id, item.head_version);
    if (!v) throw new Error(`content item ${item.id} has head_version ${item.head_version} but no such version row`);
    return { blocks: v.blocks, seo: v.seo };
  }

  /**
   * WSK-49b — UPDATE / RESTORE by a client editor: every path the new content changes against the HEAD
   * version must be client-editable (WSK-D59), else 422 field-not-client-editable for the whole write. A
   * stale baseVersion is the ordinary 409 first (the head moved, so a diff against it would blame the
   * client for someone else's change). A no-op for any other principal.
   */
  private async assertClientEdit(
    client: PoolClient,
    ctx: EditorialCommandContext,
    item: ItemRow,
    composition: CollectionComposition,
    baseVersion: number,
    blocks: unknown,
    seo: unknown,
  ): Promise<void> {
    if (!isClientEditor(ctx.principal)) return;
    if (baseVersion !== item.head_version) throw this.versionConflict(item, await this.headRef(client, item));
    const violations = clientEditViolations(composition, await this.headContent(client, item), { blocks, seo });
    if (violations.length > 0) throw fieldNotClientEditable(violations);
  }

  /**
   * WSK-49b — CREATE by a client editor: allowed only in a collection where something is client-editable,
   * never in the redirect system collection (its values live under seo, which is never client-editable), and
   * every non-editable part of the content must be absent or its default (seo empty). A no-op for any other principal.
   */
  private assertClientCreate(ctx: EditorialCommandContext, collectionKey: string, composition: CollectionComposition, blocks: unknown, seo: unknown): void {
    if (!isClientEditor(ctx.principal)) return;
    if (fieldsCarrierFor(collectionKey) === "seo.redirect" || !collectionAcceptsClientCreate(composition)) {
      throw fieldNotClientEditable(
        ["/collectionKey"],
        `Nothing in collection "${collectionKey}" is client-editable, so a client editor cannot create an item in it. Nothing was written.`,
      );
    }
    const violations = clientCreateViolations(composition, { blocks, seo });
    if (violations.length > 0) throw fieldNotClientEditable(violations);
  }

  /**
   * WSK-49b / WSK-D62 ("a client may publish only what a client could have changed") — PUBLISH by a client
   * editor. For EACH item, the paths that differ between its currently PUBLISHED version (an empty baseline
   * when it was never published) and the version being published must all be client-editable, else the WHOLE
   * publish is 422 publish-not-client-editable and nothing is written. It is a pre-pass over every item, run
   * after the guards and inside the transaction but before any projection change, so a batch with one bad
   * item publishes none. The diff is changedContentPointers (through clientEditViolations /
   * clientCreateViolations); there is no second one. A no-op for any other principal.
   */
  private async assertClientPublish(
    client: PoolClient,
    ctx: EditorialCommandContext,
    rows: Map<string, ItemRow>,
    items: { itemId: string; version: number }[],
  ): Promise<void> {
    if (!isClientEditor(ctx.principal)) return;
    const found: { index: number; pointers: string[] }[] = [];
    for (const [index, req] of items.entries()) {
      const item = rows.get(req.itemId) as ItemRow;
      if (item.deleted_at) continue; // the ordinary loop answers 409 item-deleted
      const source = await this.loadVersion(client, item.id, req.version);
      if (!source) continue; // the ordinary loop answers 409 version-not-found
      const composition = compositionOf(item.collection_key, item.composition);
      const next = { blocks: source.blocks, seo: source.seo };
      let pointers: string[];
      if (item.published_version !== null) {
        const live = await this.loadVersion(client, item.id, item.published_version);
        if (!live) throw new Error(`content item ${item.id} has published_version ${item.published_version} but no such version row`);
        pointers = clientEditViolations(composition, { blocks: live.blocks, seo: live.seo }, next);
      } else if (item.head_version === 0 && (item.publish_state === "published" || item.publish_state === "scheduled")) {
        // A pre-0009 row: its projection IS what was published.
        pointers = clientEditViolations(composition, { blocks: item.blocks, seo: item.seo ?? {} }, next);
      } else {
        pointers = clientCreateViolations(composition, next); // never published: an empty baseline
      }
      if (pointers.length > 0) found.push({ index, pointers });
    }
    if (found.length > 0) throw publishNotClientEditable(found);
  }

  /**
   * M5-W2c — the review gate as a pre-pass over the WHOLE batch (one unapproved item refuses all of them, 409
   * review-not-approved), run under the item locks and before any effect. A deleted item is left to the ordinary
   * loop (409 item-deleted), as assertClientPublish does. A version that does not exist can never be the approved
   * one (approved_version is a foreign key into content_versions), so on a review-required collection it is refused
   * here; on any other collection the ordinary loop answers 409 version-not-found as before. A no-op where review is off.
   */
  private async assertReviewGate(
    client: PoolClient,
    ctx: EditorialCommandContext,
    rows: Map<string, ItemRow>,
    items: { itemId: string; version: number }[],
  ): Promise<void> {
    const gate: GateItem[] = [];
    for (const [index, req] of items.entries()) {
      const item = rows.get(req.itemId) as ItemRow;
      if (item.deleted_at) continue;
      gate.push({ index, itemId: item.id, collectionKey: item.collection_key, version: req.version });
    }
    await assertReviewApproved(client, ctx.siteId, gate);
  }

  /**
   * M5-V5-a — the experiment lock as a pre-pass over the WHOLE batch (one locked item refuses all of them, 409
   * experiment-locked), run under the item locks and before any effect. Only an item that is LIVE right now has a
   * running test: its baseline is the published version (a pre-0009 row's projection is its live content). An item
   * that is not live, is deleted or names a missing version is left to the ordinary loop. A no-op when the live
   * version carries no experiment.
   */
  private async assertExperimentNotLocked(
    client: PoolClient,
    rows: Map<string, ItemRow>,
    items: { itemId: string; version: number }[],
  ): Promise<void> {
    const found: { itemIndex: number; itemId: string; violations: ExperimentLockViolation[] }[] = [];
    for (const [index, req] of items.entries()) {
      const item = rows.get(req.itemId) as ItemRow;
      if (item.deleted_at || !item.is_live) continue;
      const source = await this.loadVersion(client, item.id, req.version);
      if (!source) continue;
      let liveBlocks: unknown;
      if (item.published_version !== null) {
        const live = await this.loadVersion(client, item.id, item.published_version);
        if (!live) throw new Error(`content item ${item.id} has published_version ${item.published_version} but no such version row`);
        liveBlocks = live.blocks;
      } else if (item.head_version === 0) {
        liveBlocks = item.blocks; // a pre-0009 row: its projection IS what is live
      } else {
        continue;
      }
      const violations = experimentLockViolations(liveBlocks, source.blocks);
      if (violations.length > 0) found.push({ itemIndex: index, itemId: item.id, violations });
    }
    if (found.length === 0) return;
    const MAX_LISTED = 50;
    const listed = found.flatMap((f) => f.violations.map((v) => ({ path: `/items/${f.itemIndex}${v.pointer}`, message: v.reason })));
    throw problems.conflict(
      "experiment-locked",
      "Experiment locked",
      "An item in this request has a running A/B test (its live version carries an experiment block), and the version to publish changes the experiment or the control values it overrides. " +
        "Stop the test first (publish a version without the experiment block), then change the content. Nothing was published.",
      { issues: listed.slice(0, MAX_LISTED), total: listed.length },
    );
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
    return announceContentEvent(
      { logger: this.logger, webhooks: this.webhooks },
      { tenantId: ctx.tenant.id, tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, command: ctx.command },
      kind,
      refs,
      extra,
    );
  }

  // ==============================================================================================
  // content.create
  // ==============================================================================================
  async createItem(ctx: EditorialCommandContext, input: CreateItemInput): Promise<ItemWriteResult> {
    assertClientMayRun(ctx.principal, "content.create");
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
        this.assertClientCreate(ctx, col.key, composition, assembled.blocks, assembled.seo);
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
          // Live rows only (WSK-D51): a soft-deleted item releases its slug, exactly as
          // ux_content_items_slug_live (0010) does. The index stays the race-proof backstop.
          `SELECT 1 FROM content_items WHERE collection_id = $1 AND locale = $2 AND slug = $3 AND deleted_at IS NULL`,
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
        const { rows } = await client.query<ItemRow>(
          `INSERT INTO content_items AS ci
             (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
              publish_state, search_text, head_version)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::uuid, gen_random_uuid()), $8::jsonb, $9::jsonb, 'draft', $10, 1)
           RETURNING ${ITEM_COLUMNS}`,
          [itemId, ctx.tenant.id, ctx.siteId, col.id, input.locale, input.slug, groupId, JSON.stringify(assembled.blocks), JSON.stringify(assembled.seo), extractSearchText(assembled.blocks)],
        );
        const stored = await insertContentVersion(client, {
          tenantId: ctx.tenant.id,
          itemId,
          version: 1,
          blocks: assembled.blocks,
          seo: assembled.seo,
          publishState: "draft",
          createdBy: ctx.principal.sub,
          note: input.note ?? null,
          attribution: attributionOf(ctx.principal),
        });
        // M5-W2b: on a review-required collection the new item enters the flow as a draft by its creator.
        await onItemCreated(client, { tenantId: ctx.tenant.id, siteId: ctx.siteId, itemId, collectionKey: col.key, actor: ctx.principal.sub });
        const lint = await this.lint(client, ctx, composition, assembled.blocks, input.locale, assembled.seo, rows[0].localization_group_id);
        return {
          result: {
            item: toState({ ...rows[0], collection_key: col.key }),
            version: { version: 1, contentHash: stored.contentHash, createdAt: iso(stored.createdAt) as string },
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
    assertClientMayRun(ctx.principal, "content.update");
    return this.execute<Omit<ItemWriteResult, "replayed">>(
      ctx,
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, baseVersion: input.baseVersion },
      async (client) => {
        const item = await this.lockItem(client, ctx.siteId, itemId);
        this.assertNotDeleted(item);
        const composition = compositionOf(item.collection_key, item.composition);
        const assembled = assembleItemContent(item.collection_key, composition, input);
        await this.assertClientEdit(client, ctx, item, composition, input.baseVersion, assembled.blocks, assembled.seo);
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
    assertClientMayRun(ctx.principal, "content.restoreVersion");
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
        await this.assertClientEdit(client, ctx, item, composition, input.baseVersion, source.blocks, source.seo);
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
    const lint = await this.lint(client, ctx, composition, blocks, item.locale, seo, item.localization_group_id);
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
    assertClientMayRun(ctx.principal, "content.publish");
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
        await this.assertClientPublish(client, ctx, rows, input.items);
        await this.assertReviewGate(client, ctx, rows, input.items);
        await this.assertExperimentNotLocked(client, rows, input.items);
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
            const lastPublishedAt = await applyPublishEffect(client, {
              itemId: item.id,
              source,
              version: req.version,
              publishedBy: ctx.principal.sub,
              publishedAt: null,
              unpublishAt: { mode: "keep" },
            });
            publishedAt = iso(lastPublishedAt) as string;
          }
          // The newest human decision wins (WSK-61): a pending version swap on this item is moot now.
          await cancelPendingSwap(client, item.id, "superseded-by-publish");
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
    assertClientMayRun(ctx.principal, "content.schedule");
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
        // A schedule that publishes puts a version live at publishAt: gated now (a takedown-only schedule is not).
        if (input.publishAt !== null) await this.assertReviewGate(client, ctx, rows, input.items);
        // M5-V5-a: the same for the experiment lock (a swap scheduled onto a live item with a running test).
        if (input.publishAt !== null) await this.assertExperimentNotLocked(client, rows, input.items);
        const scheduled: ScheduleResult["scheduled"] = [];
        const refs: TenantWebhookContentItemRef[] = [];
        for (const [index, req] of input.items.entries()) {
          let item = rows.get(req.itemId) as ItemRow;
          this.assertNotDeleted(item);
          if (input.publishAt !== null) {
            const source = await this.loadVersionToSchedule(client, item, req.version, index);
            if (item.is_live) {
              // A LIVE item: its projection is what production serves right now, so the new version
              // cannot go in yet. It waits in content_schedules (migration 0012) and the scheduler
              // swaps it in at publish_at (WSK-61). The projection is untouched. The newest approved
              // decision wins: an earlier pending swap of this item is superseded in this same
              // transaction (ux_content_schedules_one_pending is the backstop).
              await cancelPendingSwap(client, item.id, "superseded");
              await client.query(
                `INSERT INTO content_schedules
                   (tenant_id, site_id, content_item_id, version, publish_at, unpublish_at, requested_by, ws4_approval_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [ctx.tenant.id, ctx.siteId, item.id, req.version, input.publishAt, input.unpublishAt, ctx.principal.sub, ctx.ws4ApprovalId],
              );
            } else {
              item = await this.adopt(client, ctx, item);
              // An item that stopped being live by TIME (its unpublish_at passed) may still hold a
              // pending swap; the schedule written now replaces it.
              await cancelPendingSwap(client, item.id, "superseded");
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
            }
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
            await this.reconcileSwapWithTakedown(client, item.id, input.unpublishAt as string);
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

  /**
   * Loads the version a schedule names and validates it against the collection's CURRENT composition,
   * exactly as content.publish does (404-style version-not-found, 422 composition violation). Shared
   * by both schedule paths (a non-live item's projection write, a live item's pending swap).
   */
  private async loadVersionToSchedule(client: PoolClient, item: ItemRow, version: number, index: number): Promise<VersionRow> {
    const source = await this.loadVersion(client, item.id, version);
    if (!source) {
      throw problems.conflict("version-not-found", "Version not found", `Item ${item.id} has no version ${version}.`, { itemIndex: index });
    }
    const composition = compositionOf(item.collection_key, item.composition);
    const issues = validateStoredContent(item.collection_key, composition, source.blocks, source.seo).map((i) => ({
      ...i,
      path: `/items/${index}${i.path}`,
    }));
    if (issues.length > 0) throw problems.compositionViolation(issues, "A version to schedule no longer satisfies its collection's composition.");
    return source;
  }

  /**
   * A scheduled takedown was just written on a live item that may have a pending version swap. The
   * takedown is the newest decision, and the swap must not silently undo it: executing the swap
   * rewrites the item's unpublish_at from the swap row. So a takedown AFTER the swap is due becomes
   * the swap's own unpublish_at; a takedown BEFORE (or at) it makes the swap moot, and it is cancelled.
   */
  private async reconcileSwapWithTakedown(client: PoolClient, itemId: string, unpublishAt: string): Promise<void> {
    const { rows } = await client.query<{ id: string; publish_at: Date }>(
      `SELECT id, publish_at FROM content_schedules
        WHERE content_item_id = $1 AND executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL`,
      [itemId],
    );
    const pending = rows[0];
    if (!pending) return;
    if (Date.parse(unpublishAt) > pending.publish_at.getTime()) {
      await client.query(`UPDATE content_schedules SET unpublish_at = $2 WHERE id = $1`, [pending.id, unpublishAt]);
    } else {
      await cancelPendingSwap(client, itemId, "superseded");
    }
  }

  // ==============================================================================================
  // content.unpublish (MEDIUM) — a takedown never waits for a second person (D46)
  // ==============================================================================================
  async unpublish(ctx: EditorialCommandContext, itemId: string, input: { expectedPublishedVersion: number }): Promise<ItemStateResult> {
    assertClientMayRun(ctx.principal, "content.unpublish");
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
        // Back to the draft model: the projection serves the head again (staging sees it,
        // production does not). The same effect the scheduler runs for a due takedown.
        const row = await applyUnpublishEffect(client, item);
        // The newest human decision wins (WSK-61): a pending version swap would republish the item.
        await cancelPendingSwap(client, item.id, "unpublished");
        const state = toState({ ...row, collection_key: item.collection_key });
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
    assertClientMayRun(ctx.principal, "content.delete");
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
        // A deleted item must not be swapped into (WSK-61). A published or scheduled item cannot reach this
        // point (409 item-is-live, above) and unpublish already cancels its swap, so through the API this
        // finds nothing; it keeps the invariant "a deleted item has no pending swap" true by construction.
        await cancelPendingSwap(client, item.id, "deleted");
        return { result: { item: toState({ ...rows[0], collection_key: item.collection_key }) } };
      },
    );
  }
}
