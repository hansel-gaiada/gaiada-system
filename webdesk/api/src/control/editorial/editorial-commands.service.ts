// M5-W2b (writers' room design section 4.3) — the editorial review commands:
//   editorial.submit / withdraw / requestChanges / seoSignoff / approve   the state machine (editorial-model.ts)
//   editorial.assign / comment / commentResolve                            author, dates, brief; review comments
//   editorial.policySet                                                    review on/off (+ SEO sign-off) per collection
// All MEDIUM / webdesk:operate, all editorial commands (an editorial principal), none on the client allow-list,
// all run in the shared command envelope (../command-envelope.ts): idempotency claim -> ONE transaction (audit
// row `control.editorial.<cmd>` FIRST, the effect, the idempotency record) -> replay returns `replayed: true`.
//
// REVIEW IS OFF BY DEFAULT. A collection with no editorial_policies row (or review_required = false) refuses
// every item command with 409 review-not-enabled: nothing about it changes. policySet is the only way in.
//
// What WebDesk enforces itself (the ERP's Cerbos decided first; these are the invariants that must hold even
// if a caller skips it):
//   * the state machine and the version pin (409 review-state-conflict / review-version-mismatch);
//   * approve and seoSignoff are HUMAN decisions: an automation or agent principal is 403
//     review-principal-not-allowed (the contributor class, W1e, will join this refusal when its `xc` marker
//     lands);
//   * MAKER != CHECKER: the approver may not be the creator of the version being approved (403
//     review-self-approval), compared against content_versions.created_by. SEO sign-off has no such rule.
// No tenant webhook event is emitted: review data never leaves the control plane (design 4.6).
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import type { AuditArgs } from "../../audit/audit.service";
import { CommandEnvelope, type EffectOutcome } from "../command-envelope";
import type { CommandName } from "../command-types";
import type { EditorialPrincipal } from "../auth/editorial-principal";
import { assertClientMayRun } from "../auth/client-editor";
import { assertContributorMayRun } from "../auth/contributor-editor";
import { computeCommandHash } from "../auth/ws4-assertion";
import { ContentCommandsService } from "../content/content-commands.service";
import { problems } from "../content/content-problem";
import { validateCollectionComposition, type CollectionComposition } from "../../delivery/vocabulary/composition";
import { lintContent, resolveContentRulesFromComposition } from "../content/content-lint";
import { evaluateTransition, type TransitionCommand } from "./editorial-model";
import { editorialProblems } from "./editorial-problems";
import {
  EDITORIAL_COLUMNS,
  countOpenComments,
  insertEvent,
  loadPolicy,
  viewOf,
  type EditorialRow,
  type EditorialView,
  type PolicyRow,
} from "./editorial-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** editorial_items.seo_snapshot is CHECKed to 64 KiB; stay well inside it. */
const SNAPSHOT_MAX_BYTES = 60_000;

export interface EditorialCommandContext {
  tenant: { id: string; slug: string };
  siteId: string;
  principal: EditorialPrincipal;
  idempotencyKey: string;
}

export interface AssignInput {
  /** Present = set. */
  authorSub?: string;
  /** Present = set; null clears. */
  dueAt?: string | null;
  plannedPublishAt?: string | null;
  briefRef?: string | null;
}

export interface CommentInput {
  version: number;
  /** RFC 6901 JSON pointer into the version's fields, <= 512 chars; omitted = the whole item. */
  anchor?: string;
  body: string;
}

export interface PolicyInput {
  reviewRequired: boolean;
  seoSignoffRequired: boolean;
}

interface LockedItem {
  id: string;
  collectionKey: string;
  headVersion: number;
  locale: string;
  groupId: string;
}

export type TransitionResult = { itemId: string; editorial: EditorialView };

@Injectable()
export class EditorialCommandsService {
  constructor(
    private readonly db: DbService,
    private readonly envelope: CommandEnvelope,
    private readonly content: ContentCommandsService,
  ) {}

  resolveTenantSite(tenantSlug: string, siteId: string) {
    return this.content.resolveTenantSite(tenantSlug, siteId);
  }

  // ==============================================================================================
  // The envelope adapter and the shared row operations
  // ==============================================================================================
  private execute<R extends object>(
    ctx: EditorialCommandContext,
    command: CommandName,
    requestArgs: Record<string, unknown>,
    auditArgs: AuditArgs,
    effect: (client: PoolClient) => Promise<EffectOutcome<R>>,
  ): Promise<R & { replayed: boolean }> {
    // A client editor is refused by EditorialAssertionGuard (these commands are not on the client allow-list);
    // checked again here so a service call that skipped the guard cannot slip through.
    assertClientMayRun(ctx.principal, command);
    assertContributorMayRun(ctx.principal, command);
    return this.envelope.run<R>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, ...requestArgs }),
      actor: ctx.principal.sub,
      auditArgs,
      ws4ApprovalId: null, // MEDIUM: no WS4 approval to claim
      effect,
    });
  }

  /** Locks the content item (FOR UPDATE, the order the content commands use). 404 for any miss; 409 item-deleted. */
  private async lockItem(client: PoolClient, ctx: EditorialCommandContext, itemId: string): Promise<LockedItem> {
    if (!UUID_RE.test(itemId)) throw problems.itemNotFound();
    const { rows } = await client.query<{
      id: string;
      head_version: number;
      deleted_at: Date | null;
      locale: string;
      localization_group_id: string;
      collection_key: string;
    }>(
      `SELECT ci.id, ci.head_version, ci.deleted_at, ci.locale, ci.localization_group_id, c.key AS collection_key
         FROM content_items ci JOIN collections c ON c.id = ci.collection_id
        WHERE ci.id = $1 AND ci.site_id = $2 AND ci.tenant_id = $3
        FOR UPDATE OF ci`,
      [itemId, ctx.siteId, ctx.tenant.id],
    );
    const r = rows[0];
    if (!r) throw problems.itemNotFound();
    if (r.deleted_at) throw problems.conflict("item-deleted", "Item deleted", "This item has been deleted.");
    return { id: r.id, collectionKey: r.collection_key, headVersion: r.head_version, locale: r.locale, groupId: r.localization_group_id };
  }

  /** The review row, created (as an untouched draft) on first touch, and locked. */
  private async lockReviewRow(client: PoolClient, ctx: EditorialCommandContext, item: LockedItem): Promise<EditorialRow> {
    await client.query(
      `INSERT INTO editorial_items (content_item_id, tenant_id, site_id) VALUES ($1, $2, $3) ON CONFLICT (content_item_id) DO NOTHING`,
      [item.id, ctx.tenant.id, ctx.siteId],
    );
    const { rows } = await client.query<EditorialRow>(`SELECT ${EDITORIAL_COLUMNS} FROM editorial_items ei WHERE ei.content_item_id = $1 FOR UPDATE`, [item.id]);
    return rows[0];
  }

  /** Lock the item, require review ON for its collection (409 review-not-enabled), lock its review row. */
  private async begin(client: PoolClient, ctx: EditorialCommandContext, itemId: string): Promise<{ item: LockedItem; policy: PolicyRow; row: EditorialRow }> {
    const item = await this.lockItem(client, ctx, itemId);
    const policy = await loadPolicy(client, ctx.siteId, item.collectionKey);
    if (!policy.reviewRequired) throw editorialProblems.notEnabled(item.collectionKey);
    const row = await this.lockReviewRow(client, ctx, item);
    return { item, policy, row };
  }

  private async result(client: PoolClient, itemId: string, collectionKey: string, siteId: string): Promise<TransitionResult> {
    const policy = await loadPolicy(client, siteId, collectionKey);
    const { rows } = await client.query<EditorialRow>(`SELECT ${EDITORIAL_COLUMNS} FROM editorial_items ei WHERE ei.content_item_id = $1`, [itemId]);
    const head = await client.query<{ head_version: number }>(`SELECT head_version FROM content_items WHERE id = $1`, [itemId]);
    return { itemId, editorial: viewOf(rows[0] ?? null, policy, head.rows[0].head_version, await countOpenComments(client, itemId)) };
  }

  // ==============================================================================================
  // submit / withdraw / requestChanges / seoSignoff / approve
  // ==============================================================================================
  submit(ctx: EditorialCommandContext, itemId: string, input: { version: number }) {
    return this.transition(ctx, "submit", itemId, input.version, null);
  }

  withdraw(ctx: EditorialCommandContext, itemId: string) {
    return this.transition(ctx, "withdraw", itemId, null, null);
  }

  requestChanges(ctx: EditorialCommandContext, itemId: string, input: { version: number; note: string }) {
    return this.transition(ctx, "requestChanges", itemId, input.version, input.note);
  }

  seoSignoff(ctx: EditorialCommandContext, itemId: string, input: { version: number }) {
    return this.transition(ctx, "seoSignoff", itemId, input.version, null);
  }

  approve(ctx: EditorialCommandContext, itemId: string, input: { version: number }) {
    return this.transition(ctx, "approve", itemId, input.version, null);
  }

  /** One legal-transition command. `version` is the version the caller acted on (null for withdraw). */
  private transition(
    ctx: EditorialCommandContext,
    cmd: TransitionCommand,
    itemId: string,
    version: number | null,
    note: string | null,
  ): Promise<TransitionResult & { replayed: boolean }> {
    const command = `editorial.${cmd}` as CommandName;
    const human = cmd === "approve" || cmd === "seoSignoff";
    return this.execute<TransitionResult>(
      ctx,
      command,
      { itemId, version, note },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, version },
      async (client) => {
        const { item, policy, row } = await this.begin(client, ctx, itemId);

        // A human decision (approve, sign-off): never an automation or agent principal.
        if (human && ctx.principal.pk !== "human") throw editorialProblems.principalNotAllowed(command);

        const t = evaluateTransition(cmd, row.state);
        if (!t.ok) throw editorialProblems.stateConflict(t.currentState, command);

        // The version pin. submit acts on the head; the rest act on the version in review.
        let eventVersion: number | null = version;
        if (cmd === "submit") {
          if (version !== item.headVersion) throw editorialProblems.versionMismatch(item.headVersion, version as number, "the item's head version");
        } else if (cmd !== "withdraw") {
          if (version !== row.submitted_version) throw editorialProblems.versionMismatch(row.submitted_version as number, version as number, "the version in review");
        } else {
          eventVersion = row.submitted_version;
        }

        if (cmd === "approve") {
          // Maker != checker, against the creator of the very version being approved.
          const maker = await client.query<{ created_by: string }>(
            `SELECT created_by FROM content_versions WHERE content_item_id = $1 AND version = $2`,
            [item.id, version],
          );
          if (maker.rows[0]?.created_by === ctx.principal.sub) throw editorialProblems.selfApproval(version as number);
          if (policy.seoSignoffRequired && row.seo_signed_version !== version) throw editorialProblems.seoSignoffRequired(version as number);
        }

        if (cmd === "submit") {
          await client.query(
            `UPDATE editorial_items SET state = $2, submitted_version = $3, updated_at = now() WHERE content_item_id = $1`,
            [item.id, t.to, version],
          );
        } else if (cmd === "seoSignoff") {
          const snapshot = await this.seoSnapshot(client, ctx, item, version as number);
          await client.query(
            `UPDATE editorial_items SET seo_signed_version = $2, seo_signed_by = $3, seo_snapshot = $4::jsonb, updated_at = now() WHERE content_item_id = $1`,
            [item.id, version, ctx.principal.sub, JSON.stringify(snapshot)],
          );
        } else if (cmd === "approve") {
          await client.query(
            `UPDATE editorial_items
                SET state = $2, approved_version = $3, approved_by = $4, approved_at = now(), updated_at = now()
              WHERE content_item_id = $1`,
            [item.id, t.to, version, ctx.principal.sub],
          );
        } else {
          // withdraw, requestChanges: the state moves, no version is stamped.
          await client.query(`UPDATE editorial_items SET state = $2, updated_at = now() WHERE content_item_id = $1`, [item.id, t.to]);
        }
        await insertEvent(client, { tenantId: ctx.tenant.id, itemId: item.id, version: eventVersion, kind: t.event, actor: ctx.principal.sub, note });
        return { result: await this.result(client, item.id, item.collectionKey, ctx.siteId) };
      },
    );
  }

  /**
   * The SEO/AEO report of the signed version, computed HERE from the stored version (never taken from the
   * caller). Advisory data: a failure to compute becomes an `unavailable` entry, never a refusal of the sign-off.
   */
  private async seoSnapshot(client: PoolClient, ctx: EditorialCommandContext, item: LockedItem, version: number): Promise<Record<string, unknown>> {
    const computedAt = new Date().toISOString();
    try {
      const v = await client.query<{ blocks: unknown; seo: unknown }>(`SELECT blocks, seo FROM content_versions WHERE content_item_id = $1 AND version = $2`, [item.id, version]);
      const col = await client.query<{ schema: unknown }>(`SELECT schema FROM collections WHERE site_id = $1 AND key = $2`, [ctx.siteId, item.collectionKey]);
      const valid = validateCollectionComposition(item.collectionKey, col.rows[0]?.schema);
      if (!v.rows[0] || !valid.valid) {
        return { version, computedAt, content: { findings: [], aeo: null, unavailable: [{ rule: "content", reason: "the stored composition or version could not be read" }] } };
      }
      const twins = await client.query<{ locale: string }>(
        `SELECT locale FROM content_items WHERE site_id = $1 AND localization_group_id = $2 AND deleted_at IS NULL`,
        [ctx.siteId, item.groupId],
      );
      const cfg = resolveContentRulesFromComposition(col.rows[0].schema as CollectionComposition); // M5-W3c: the site's settings
      if (!cfg.enabled) return { version, computedAt }; // the site switched the content checks off: no `content` member
      const report = lintContent(
        { blocks: v.rows[0].blocks, seo: v.rows[0].seo, composition: col.rows[0].schema as CollectionComposition, locale: item.locale, groupLocales: twins.rows.map((r) => r.locale) },
        cfg,
      );
      const snap: Record<string, unknown> = { version, computedAt, content: report };
      if (Buffer.byteLength(JSON.stringify(snap)) > SNAPSHOT_MAX_BYTES) {
        return { version, computedAt, truncated: true, content: { findings: report.findings.slice(0, 100), aeo: report.aeo, unavailable: report.unavailable.slice(0, 50) } };
      }
      return snap;
    } catch (e) {
      return { version, computedAt, content: { findings: [], aeo: null, unavailable: [{ rule: "content", reason: e instanceof Error ? e.message.slice(0, 200) : "unexpected error" }] } };
    }
  }

  // ==============================================================================================
  // editorial.assign — author and dates; moves no state
  // ==============================================================================================
  assign(ctx: EditorialCommandContext, itemId: string, input: AssignInput) {
    return this.execute<TransitionResult>(
      ctx,
      "editorial.assign",
      { itemId, ...input },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId },
      async (client) => {
        const { item, row } = await this.begin(client, ctx, itemId);
        const has = (k: keyof AssignInput): boolean => Object.prototype.hasOwnProperty.call(input, k);
        await client.query(
          `UPDATE editorial_items
              SET author_sub = $2, due_at = $3, planned_publish_at = $4, brief_ref = $5, updated_at = now()
            WHERE content_item_id = $1`,
          [
            item.id,
            has("authorSub") ? input.authorSub : row.author_sub,
            has("dueAt") ? input.dueAt : row.due_at,
            has("plannedPublishAt") ? input.plannedPublishAt : row.planned_publish_at,
            has("briefRef") ? input.briefRef : row.brief_ref,
          ],
        );
        await insertEvent(client, { tenantId: ctx.tenant.id, itemId: item.id, version: null, kind: "review.assigned", actor: ctx.principal.sub });
        return { result: await this.result(client, item.id, item.collectionKey, ctx.siteId) };
      },
    );
  }

  // ==============================================================================================
  // editorial.comment / editorial.commentResolve — a comment body is immutable (0016)
  // ==============================================================================================
  comment(ctx: EditorialCommandContext, itemId: string, input: CommentInput) {
    const commentId = randomUUID();
    return this.execute<{ itemId: string; commentId: string; version: number }>(
      ctx,
      "editorial.comment",
      { itemId, version: input.version, anchor: input.anchor ?? null, body: input.body },
      // The audit row names the ids and the version, never the comment text.
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, commentId, version: input.version },
      async (client) => {
        const { item } = await this.begin(client, ctx, itemId);
        const v = await client.query(`SELECT 1 FROM content_versions WHERE content_item_id = $1 AND version = $2`, [item.id, input.version]);
        if (v.rows.length === 0) throw problems.conflict("version-not-found", "Version not found", `Version ${input.version} does not exist for this item.`);
        await client.query(
          `INSERT INTO editorial_comments (id, tenant_id, content_item_id, version, anchor, body, author_sub) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [commentId, ctx.tenant.id, item.id, input.version, input.anchor ?? null, input.body, ctx.principal.sub],
        );
        await insertEvent(client, { tenantId: ctx.tenant.id, itemId: item.id, version: input.version, kind: "review.comment", actor: ctx.principal.sub });
        return { result: { itemId: item.id, commentId, version: input.version } };
      },
    );
  }

  commentResolve(ctx: EditorialCommandContext, itemId: string, commentId: string) {
    return this.execute<{ itemId: string; commentId: string; resolvedAt: string; resolvedBy: string; alreadyResolved: boolean }>(
      ctx,
      "editorial.commentResolve",
      { itemId, commentId },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, commentId },
      async (client) => {
        const { item } = await this.begin(client, ctx, itemId);
        if (!UUID_RE.test(commentId)) throw editorialProblems.commentNotFound();
        const { rows } = await client.query<{ version: number; resolved_at: Date | null; resolved_by: string | null }>(
          `SELECT version, resolved_at, resolved_by FROM editorial_comments WHERE id = $1 AND content_item_id = $2 FOR UPDATE`,
          [commentId, item.id],
        );
        const c = rows[0];
        if (!c) throw editorialProblems.commentNotFound();
        // Resolving twice changes nothing and writes no second event (the first resolver stays on record).
        if (c.resolved_at) {
          return { result: { itemId: item.id, commentId, resolvedAt: new Date(c.resolved_at).toISOString(), resolvedBy: c.resolved_by as string, alreadyResolved: true } };
        }
        const { rows: upd } = await client.query<{ resolved_at: Date }>(
          `UPDATE editorial_comments SET resolved_at = now(), resolved_by = $2 WHERE id = $1 RETURNING resolved_at`,
          [commentId, ctx.principal.sub],
        );
        await insertEvent(client, { tenantId: ctx.tenant.id, itemId: item.id, version: c.version, kind: "review.comment_resolved", actor: ctx.principal.sub });
        return { result: { itemId: item.id, commentId, resolvedAt: new Date(upd[0].resolved_at).toISOString(), resolvedBy: ctx.principal.sub, alreadyResolved: false } };
      },
    );
  }

  // ==============================================================================================
  // editorial.policySet — review on/off per (site, collection); both flags move together
  // ==============================================================================================
  /**
   * Turning review off clears BOTH flags (an SEO sign-off with no review can never be asked for; the table
   * CHECK says so too). The controller refuses the contradictory request (sign-off on, review off) with 400.
   * Items already in flight keep their state; commands refuse while review is off, and resume if it is turned
   * back on. approved_version is untouched either way.
   */
  policySet(ctx: EditorialCommandContext, collectionKey: string, input: PolicyInput) {
    const seo = input.reviewRequired ? input.seoSignoffRequired : false;
    return this.execute<{ collectionKey: string; reviewRequired: boolean; seoSignoffRequired: boolean; updatedBy: string; updatedAt: string }>(
      ctx,
      "editorial.policySet",
      { collectionKey, reviewRequired: input.reviewRequired, seoSignoffRequired: input.seoSignoffRequired },
      { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, collectionKey, reviewRequired: input.reviewRequired, seoSignoffRequired: seo },
      async (client) => {
        const col = await client.query(`SELECT 1 FROM collections WHERE site_id = $1 AND key = $2 FOR SHARE`, [ctx.siteId, collectionKey]);
        if (col.rows.length === 0) throw problems.collectionNotFound();
        const { rows } = await client.query<{ updated_at: Date }>(
          `INSERT INTO editorial_policies (tenant_id, site_id, collection_key, review_required, seo_signoff_required, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (site_id, collection_key)
           DO UPDATE SET review_required = EXCLUDED.review_required, seo_signoff_required = EXCLUDED.seo_signoff_required,
                         updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING updated_at`,
          [ctx.tenant.id, ctx.siteId, collectionKey, input.reviewRequired, seo, ctx.principal.sub],
        );
        return {
          result: {
            collectionKey,
            reviewRequired: input.reviewRequired,
            seoSignoffRequired: seo,
            updatedBy: ctx.principal.sub,
            updatedAt: new Date(rows[0].updated_at).toISOString(),
          },
        };
      },
    );
  }
}

