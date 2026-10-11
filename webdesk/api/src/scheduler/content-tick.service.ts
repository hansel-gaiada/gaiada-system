// WSK-61 — the content tick: what time alone cannot do to content_items.
//
// The frozen /v1 read path already honours publish_at / unpublish_at BY TIME (a `scheduled` item is
// live once publish_at <= now(), any item stops being live at unpublish_at), so visibility needs no
// worker. The tick exists to make the STORED state catch up with what production already sees, and
// for the one thing time cannot do: swap a new version into an item that is live right now.
//
// ONE TICK, per active tenant, under that tenant's webdesk.tenant_ctx, three steps in this order:
//   1. due publishes   publish_state 'scheduled', publish_at <= now      -> 'published'
//   2. due swaps       pending content_schedules row, publish_at <= now  -> publish(v)'s projection effect
//   3. due takedowns   published/scheduled, unpublish_at <= now         -> content.unpublish's effect
//
// ONE TRANSACTION PER ITEM, and it is the unit of both locking and failure:
//   * the candidate is chosen with `FOR UPDATE OF ci SKIP LOCKED LIMIT 1`, so two replicas (or two
//     overlapping ticks) never process the same item: the second skips what the first holds, and
//     because the statement runs at READ COMMITTED a row the first already committed is re-evaluated
//     against its NEW state by the lock, fails the predicate and drops out. Each item is therefore
//     transitioned exactly once. Items are always locked ITEM FIRST (the swap row is read only after
//     its item is locked), the same order every command uses, so the scheduler cannot deadlock with
//     content.schedule / publish / unpublish / delete.
//   * an item that throws rolls back alone, is logged, counted in `errors`, and is not retried within
//     the tick (its id is remembered); it is still due, so the next tick tries it again.
//   * a step is capped at MAX_ITEMS_PER_STEP items per tenant per tick; the rest are next tick's.
//
// Every EXECUTED transition writes one audit row `control.content.schedule.executed` (actor
// `system:scheduler`) in the item's own transaction, with ws4_approval_id NULL: 0009's single-use
// index on that column must never see a second use of an approval. A swap's original approval id goes
// in the audit args instead. After the commit, fail-soft, the tenant webhook (`content.published` for
// a publish or a swap, `content.unpublished` for a takedown) goes out through the same path the
// commands use (announceContentEvent). A webhook outage can never undo a committed transition.
//
// THE REVIEW GATE AT FIRE TIME (M5-W2c). content.schedule already refused any unapproved version on a review-required
// collection, but a pending swap waits, and the approval can stop matching in the meantime: a newer version is
// approved, or review is switched on for the collection. So step 2 asks the gate again, under the item lock, with the
// swap's EXACT version; a refusal marks the swap row failed (`review-not-approved: …`, counted in swapsFailed) and the
// live version keeps serving. An edit after approval does NOT stale it: approved_version survives the edit (design
// 4.1), and it is still exactly the bytes that were approved. Step 1 (a non-live item's scheduled publish) cannot be
// re-gated here: the frozen /v1 read path shows it BY TIME at publish_at, before any tick, and its projection was
// gated when it was scheduled.
//
// The projection effects are NOT written here: applyPublishEffect / applyUnpublishEffect
// (control/content/content-transitions.ts) are the same functions content.publish and
// content.unpublish run.
import { Injectable, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { AuditService, type AuditArgs } from "../audit/audit.service";
import { ZoneBEventEmitterService } from "../events/zoneb-event-emitter.service";
import { groupFired, type FiredTransition } from "./schedule-fired";
import { TenantWebhookDispatcherService } from "../tenant-webhooks/tenant-webhook-dispatcher.service";
import type { TenantWebhookContentEventKind, TenantWebhookContentItemRef } from "../tenant-webhooks/tenant-webhook-event.types";
import { validateCollectionComposition, type CollectionComposition } from "../delivery/vocabulary/composition";
import { validateStoredContent } from "../control/content/content-projection";
import { reviewRefusals, swapRefusalReason } from "../control/editorial/review-gate";
import { attributionOf } from "../control/content/content-versions";
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
} from "../control/content/content-transitions";

export const SCHEDULER_ACTOR = "system:scheduler";
export const SCHEDULE_EXECUTED_ACTION = "control.content.schedule.executed";
/** At most this many items per step per tenant per tick; the remainder is next tick's. */
export const MAX_ITEMS_PER_STEP = 500;
const FAIL_REASON_MAX = 500;

export interface TenantTickResult {
  tenantId: string;
  tenantSlug: string;
  /** step 1: scheduled -> published */
  published: number;
  /** step 2: pending swaps applied */
  swapped: number;
  /** step 2: pending swaps cancelled because the item was deleted or no longer live */
  swapsCancelled: number;
  /** step 2: pending swaps whose version no longer validates, or (M5-W2c) is no longer the approved one (nothing changed) */
  swapsFailed: number;
  /** step 3: published/scheduled -> unpublished */
  tookDown: number;
  /** items whose transaction threw (rolled back, still due) */
  errors: number;
}

export interface ContentTickResult {
  now: string;
  tenants: TenantTickResult[];
  totals: Omit<TenantTickResult, "tenantId" | "tenantSlug">;
}

type Counter = "published" | "swapped" | "swapsCancelled" | "swapsFailed" | "tookDown";

interface TenantRef {
  id: string;
  slug: string;
  /** tenants.company_ref: the ERP company id, the Zone B event's tenantId. */
  company_ref: string;
}

interface StepOutcome {
  count: Counter | null;
  /** The transition this transaction committed (what schedule.fired reports). */
  fired?: FiredTransition;
  after?: () => Promise<void>;
}

/** A step claims ONE due item inside the given transaction, applies it, and returns null when none is left. */
type Step = (client: PoolClient, claimed: string[]) => Promise<StepOutcome | null>;

interface CandidateRow extends ItemColumnsRow {
  site_id: string;
  collection_key: string;
}

interface SwapCandidateRow extends CandidateRow {
  composition: unknown;
  is_live: boolean;
  schedule_id: string;
}

interface SwapRow {
  id: string;
  version: number;
  publish_at: Date;
  unpublish_at: Date | null;
  requested_by: string;
  ws4_approval_id: string | null;
}

interface TakedownCandidateRow extends CandidateRow {
  blocks: unknown;
  seo: Record<string, unknown> | null;
}

@Injectable()
export class ContentTickService {
  private readonly logger = new Logger(ContentTickService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly webhooks: TenantWebhookDispatcherService,
    private readonly zoneB: ZoneBEventEmitterService,
  ) {}

  /**
   * The database's clock. The /v1 read path judges visibility by the database's now(), so the scheduled
   * worker takes its "now" from there too (SchedulerService passes this to runContentTick): an api host
   * whose clock runs ahead must not flip an item to published, or take one down, before the read path
   * would have shown it.
   */
  async databaseNow(): Promise<Date> {
    const { rows } = await this.db.query<{ now: Date }>(`SELECT now() AS now`);
    return rows[0].now;
  }

  /**
   * Runs one tick over every active tenant. `now` is injectable so a test can drive time; the scheduled
   * job passes the database's clock (databaseNow) and a direct caller with no argument gets this process's.
   * Resolves with per-tenant counts (never rejects for an item or tenant that failed: those are logged and
   * counted in `errors`).
   */
  async runContentTick(now: Date = new Date()): Promise<ContentTickResult> {
    const tenants = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<TenantRef>(`SELECT id, slug, company_ref FROM tenants WHERE status = 'active' ORDER BY slug`);
      return rows;
    });

    const results: TenantTickResult[] = [];
    for (const tenant of tenants) {
      const r: TenantTickResult = { tenantId: tenant.id, tenantSlug: tenant.slug, published: 0, swapped: 0, swapsCancelled: 0, swapsFailed: 0, tookDown: 0, errors: 0 };
      const fired: FiredTransition[] = [];
      try {
        await this.drain(tenant, r, this.duePublishStep(tenant, now), fired);
        await this.drain(tenant, r, this.dueSwapStep(tenant, now), fired);
        await this.drain(tenant, r, this.dueTakedownStep(tenant, now), fired);
      } catch (err) {
        r.errors++;
        this.logger.error(`content tick: tenant ${tenant.slug} failed: ${String(err)}`);
      }
      // Whatever committed is reported, even when a later step failed. Fail-soft, never touches r.
      await this.emitScheduleFired(tenant, fired);
      results.push(r);
    }

    const totals = results.reduce(
      (t, r) => ({
        published: t.published + r.published,
        swapped: t.swapped + r.swapped,
        swapsCancelled: t.swapsCancelled + r.swapsCancelled,
        swapsFailed: t.swapsFailed + r.swapsFailed,
        tookDown: t.tookDown + r.tookDown,
        errors: t.errors + r.errors,
      }),
      { published: 0, swapped: 0, swapsCancelled: 0, swapsFailed: 0, tookDown: 0, errors: 0 },
    );
    this.logger.log(
      `content tick @ ${now.toISOString()}: tenants=${results.length} published=${totals.published} swapped=${totals.swapped} ` +
        `swapsCancelled=${totals.swapsCancelled} swapsFailed=${totals.swapsFailed} tookDown=${totals.tookDown} errors=${totals.errors}`,
    );
    return { now: now.toISOString(), tenants: results, totals };
  }

  /** Runs `step` once per due item, one transaction each, until none is left, the cap is hit, or it stops claiming. */
  private async drain(tenant: TenantRef, counts: TenantTickResult, step: Step, fired: FiredTransition[]): Promise<void> {
    // Ids this tick has already claimed in THIS step, pushed by the step the moment it picks one, so
    // an item whose transaction throws is not re-picked in a loop.
    const claimed: string[] = [];
    while (claimed.length < MAX_ITEMS_PER_STEP) {
      const before = claimed.length;
      let outcome: StepOutcome | null;
      try {
        outcome = await this.db.withTenant(tenant.id, (db) => db.transaction((client) => step(client, claimed)));
      } catch (err) {
        // No item was claimed: the failure is not an item's (the candidate query, the connection), so
        // retrying would spin. Let the tenant-level handler record it and move on.
        if (claimed.length === before) throw err;
        counts.errors++;
        this.logger.error(`content tick: tenant ${tenant.slug} item ${claimed[claimed.length - 1]} failed and was rolled back: ${String(err)}`);
        continue;
      }
      if (!outcome) return;
      if (outcome.count) counts[outcome.count]++;
      if (outcome.fired) fired.push(outcome.fired);
      if (outcome.after) await outcome.after().catch((err) => this.logger.warn(`content tick: post-commit side effect failed: ${String(err)}`));
    }
    this.logger.warn(`content tick: tenant ${tenant.slug} hit the ${MAX_ITEMS_PER_STEP}-item cap for one step; the rest are next tick's`);
  }

  /** The schedule.fired rebuild hint: one event per (site, transition, approval) group of what committed. Never throws. */
  private async emitScheduleFired(tenant: TenantRef, fired: readonly FiredTransition[]): Promise<void> {
    if (fired.length === 0) return;
    try {
      for (const ev of groupFired(tenant.slug, fired)) {
        await this.zoneB.emitScheduleFired(tenant.company_ref, ev.data, ev.eventId);
      }
    } catch (err) {
      this.logger.warn(`content tick: tenant ${tenant.slug} schedule.fired emit failed (fail-soft): ${String(err)}`);
    }
  }

  // ==============================================================================================
  // Step 1 · due publishes
  // ==============================================================================================
  // The projection already holds the scheduled version (content.schedule put it there) and last_published_*
  // were set then, so only the STATE catches up: publish_state 'scheduled' -> 'published'. updated_at moves
  // to the instant the item went live (never backwards), so lastmod is the real go-live time.
  private duePublishStep(tenant: TenantRef, now: Date): Step {
    return async (client, claimed) => {
      const { rows } = await client.query<CandidateRow>(
        `SELECT ${ITEM_COLUMNS}, ci.site_id, c.key AS collection_key
           FROM content_items ci
           JOIN collections c ON c.id = ci.collection_id
          WHERE ci.tenant_id = $1
            AND ci.publish_state = 'scheduled' AND ci.publish_at <= $2::timestamptz AND ci.deleted_at IS NULL
            AND ci.id <> ALL($3::uuid[])
          ORDER BY ci.publish_at, ci.id
          LIMIT 1
          FOR UPDATE OF ci SKIP LOCKED`,
        [tenant.id, now, claimed],
      );
      const item = rows[0];
      if (!item) return null;
      claimed.push(item.id);

      await client.query(
        `UPDATE content_items SET publish_state = 'published', updated_at = greatest(updated_at, publish_at)
          WHERE id = $1 AND publish_state = 'scheduled'`,
        [item.id],
      );
      await this.auditExecuted(client, tenant, { kind: "publish", itemId: item.id, version: item.published_version });
      return {
        count: "published",
        fired: { siteId: item.site_id, kind: "publish", itemId: item.id, version: item.published_version, effectiveAt: item.publish_at as Date, approvalId: null },
        after: this.announce(tenant, item, "content.published", item.published_version),
      };
    };
  }

  // ==============================================================================================
  // Step 2 · due version swaps on live items
  // ==============================================================================================
  private dueSwapStep(tenant: TenantRef, now: Date): Step {
    return async (client, claimed) => {
      // Candidate = an item with a due pending swap, locked (SKIP LOCKED). The swap row is joined only to
      // pick and order; it is re-read below, after the item lock, which is what every writer of a swap
      // row holds. is_live is evaluated at the tick's clock.
      const { rows } = await client.query<SwapCandidateRow>(
        `SELECT ${ITEM_COLUMNS}, ci.site_id, c.key AS collection_key, c.schema AS composition,
                ${effectivePublishedSql("$2::timestamptz")} AS is_live, cs.id AS schedule_id
           FROM content_schedules cs
           JOIN content_items ci ON ci.id = cs.content_item_id
           JOIN collections c ON c.id = ci.collection_id
          WHERE cs.tenant_id = $1
            AND cs.executed_at IS NULL AND cs.cancelled_at IS NULL AND cs.failed_at IS NULL
            AND cs.publish_at <= $2::timestamptz
            AND ci.id <> ALL($3::uuid[])
          ORDER BY cs.publish_at, ci.id
          LIMIT 1
          FOR UPDATE OF ci SKIP LOCKED`,
        [tenant.id, now, claimed],
      );
      const item = rows[0];
      if (!item) return null;
      claimed.push(item.id);

      // Re-check under the lock: the swap may have been cancelled or executed between the candidate read
      // and the lock, in which case there is nothing to do for this item.
      const { rows: swaps } = await client.query<SwapRow>(
        `SELECT id, version, publish_at, unpublish_at, requested_by, ws4_approval_id
           FROM content_schedules
          WHERE content_item_id = $1 AND executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL
            AND publish_at <= $2::timestamptz
          FOR UPDATE`,
        [item.id, now],
      );
      const swap = swaps[0];
      if (!swap) return { count: null };

      if (item.deleted_at) {
        await cancelPendingSwap(client, item.id, "item-deleted");
        return { count: "swapsCancelled" };
      }
      if (!item.is_live) {
        // Taken down (by time or by a command that did not cancel it) before the swap fell due: a swap only
        // replaces what is live, it never brings an item back.
        await cancelPendingSwap(client, item.id, "item-not-live");
        return { count: "swapsCancelled" };
      }

      const source = await loadVersionRow(client, item.id, swap.version);
      const problem = source ? this.revalidate(item, source.blocks, source.seo) : `version ${swap.version} no longer exists`;
      if (problem !== null || !source) {
        // Nothing else changes: the live version keeps serving, the row records why.
        const reason = (problem ?? "the version could not be loaded").slice(0, FAIL_REASON_MAX);
        await client.query(`UPDATE content_schedules SET failed_at = now(), fail_reason = $2 WHERE id = $1`, [swap.id, reason]);
        this.logger.warn(`content tick: swap ${swap.id} of item ${item.id} to version ${swap.version} was not applied: ${reason}`);
        return { count: "swapsFailed" };
      }

      // M5-W2c: the review gate again, at fire time (see the header). A no-op where review is off.
      const [refusal] = await reviewRefusals(client, item.site_id, [{ index: 0, itemId: item.id, collectionKey: item.collection_key, version: swap.version }]);
      if (refusal) {
        const reason = swapRefusalReason(refusal).slice(0, FAIL_REASON_MAX);
        await client.query(`UPDATE content_schedules SET failed_at = now(), fail_reason = $2 WHERE id = $1`, [swap.id, reason]);
        this.logger.warn(`content tick: swap ${swap.id} of item ${item.id} to version ${swap.version} was not applied: ${reason}`);
        return { count: "swapsFailed" };
      }

      await applyPublishEffect(client, {
        itemId: item.id,
        source,
        version: swap.version,
        publishedBy: swap.requested_by,
        publishedAt: swap.publish_at,
        unpublishAt: { mode: "set", at: swap.unpublish_at },
      });
      await client.query(`UPDATE content_schedules SET executed_at = now() WHERE id = $1`, [swap.id]);
      await this.auditExecuted(client, tenant, {
        kind: "swap",
        itemId: item.id,
        version: swap.version,
        ...(swap.ws4_approval_id ? { approvalId: swap.ws4_approval_id } : {}),
      });
      return {
        count: "swapped",
        fired: { siteId: item.site_id, kind: "swap", itemId: item.id, version: swap.version, effectiveAt: swap.publish_at, approvalId: swap.ws4_approval_id },
        after: this.announce(tenant, item, "content.published", swap.version),
      };
    };
  }

  /** The composition check content.schedule ran, run again against the collection AS IT IS NOW. null = valid. */
  private revalidate(item: SwapCandidateRow, blocks: unknown, seo: unknown): string | null {
    const verdict = validateCollectionComposition(item.collection_key, item.composition);
    if (!verdict.valid) return `the collection's stored composition is invalid: ${verdict.issues[0]?.path ?? ""} ${verdict.issues[0]?.message ?? ""}`.trim();
    const issues = validateStoredContent(item.collection_key, item.composition as CollectionComposition, blocks, seo);
    if (issues.length === 0) return null;
    return `the version no longer satisfies the collection's composition: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`;
  }

  // ==============================================================================================
  // Step 3 · due takedowns
  // ==============================================================================================
  private dueTakedownStep(tenant: TenantRef, now: Date): Step {
    return async (client, claimed) => {
      const { rows } = await client.query<TakedownCandidateRow>(
        `SELECT ${ITEM_COLUMNS}, ci.site_id, ci.blocks, ci.seo, c.key AS collection_key
           FROM content_items ci
           JOIN collections c ON c.id = ci.collection_id
          WHERE ci.tenant_id = $1
            AND ci.publish_state IN ('published', 'scheduled') AND ci.unpublish_at <= $2::timestamptz AND ci.deleted_at IS NULL
            AND ci.id <> ALL($3::uuid[])
          ORDER BY ci.unpublish_at, ci.id
          LIMIT 1
          FOR UPDATE OF ci SKIP LOCKED`,
        [tenant.id, now, claimed],
      );
      const locked = rows[0];
      if (!locked) return null;
      claimed.push(locked.id);

      // Exactly content.unpublish's effect (a pre-0009 row is adopted first, as the command does).
      const item = await adoptLegacyItem(
        client,
        { tenantId: tenant.id, createdBy: SCHEDULER_ACTOR, attribution: attributionOf({ pk: "automation" }) },
        locked,
      );
      const takenDownVersion = item.published_version;
      await applyUnpublishEffect(client, item);
      // The item is down: a pending swap would bring it back, which nobody asked for.
      await cancelPendingSwap(client, item.id, "unpublished");
      await this.auditExecuted(client, tenant, { kind: "takedown", itemId: item.id, version: takenDownVersion });
      return {
        count: "tookDown",
        fired: { siteId: locked.site_id, kind: "takedown", itemId: item.id, version: takenDownVersion, effectiveAt: locked.unpublish_at as Date, approvalId: null },
        after: this.announce(tenant, locked, "content.unpublished", takenDownVersion),
      };
    };
  }

  // ==============================================================================================
  // Shared
  // ==============================================================================================
  private async auditExecuted(
    client: PoolClient,
    tenant: TenantRef,
    args: { kind: "publish" | "swap" | "takedown"; itemId: string; version: number | null; approvalId?: string },
  ): Promise<void> {
    await this.audit.record(client, {
      tenantId: tenant.id,
      actor: SCHEDULER_ACTOR,
      action: SCHEDULE_EXECUTED_ACTION,
      args: args as AuditArgs,
      ws4ApprovalId: null,
    });
  }

  /** The post-commit thunk: the same fan-out the commands use, for this item. */
  private announce(
    tenant: TenantRef,
    item: { id: string; site_id: string; collection_key: string; locale: string; slug: string },
    kind: TenantWebhookContentEventKind,
    version: number | null,
  ): () => Promise<void> {
    const ref: TenantWebhookContentItemRef = { itemId: item.id, collectionKey: item.collection_key, locale: item.locale, slug: item.slug, version };
    return announceContentEvent(
      { logger: this.logger, webhooks: this.webhooks },
      { tenantId: tenant.id, tenantSlug: tenant.slug, siteId: item.site_id, command: "scheduler.content-tick" },
      kind,
      [ref],
    );
  }
}
