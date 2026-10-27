// SCP-1b — the stage machine's I/O effects (FRONTEND-BFF-CONTRACT §63.3.5, §63.6.6, §63.10). The machine (`machine.ts`)
// answers the column changes and the names of the effects; this file runs each named effect inside the action's ONE
// transaction, on the client that holds the post's row lock. Keyed by the fixture's effect names (`EFFECT_RUNNERS`); a
// name the fixture lists and this file does not know refuses to load (`assertEffectCoverage`), so nothing is skipped.
//
// What runs here is only DB writes plus outbox events (which commit with the transaction). Network calls never run under
// the lock: cancelling a queued dispatch at the publisher is `cancelQueuedDispatchesBeforeTx`, run by the service before
// it opens the transaction. Notifications and activity rows run after the commit (pipeline.service.ts).
//
// Effects that belong to later tickets are named no-op hooks below, each with the ticket that fills it.
import { HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { emitEvent } from "../../../events/outbox.service";
import { insertAutomationApprovalRow, type FileApprovalInput } from "../../../core/approval-filing";
import * as wr from "../../../core/work-requests.service";
import { variantArgsSha256, variantPublishArgs } from "../canonical-args";
import { estimateCostUsd, isNetwork, supportsFirstCommentFor, validateVariant, type Network } from "../media-rules";
import { resolveXPricing } from "../usage-ledger";
import { SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_TOOL_CLASSIFICATION } from "../publish-precondition";
import { assertDispatchChain, resolveDispatchOrgHandle } from "../publisher/provisioning";
import { SCP } from "./fixture";
import { syncContentMonthProgress } from "./content-month-progress";
import { captionWithHashtags } from "./handoff-checks";
import { COLUMN_EFFECTS, splitEffect, type PipelinePostState, type StageApplied } from "./machine";
import {
  findDepartmentBySlug, loadClientAccounts, loadDesigns, loadVariants, resolveAssetGroup,
  type CycleRow, type EngagementRow, type PostRow,
} from "./pipeline-data";

/** A refusal raised by an effect or the service: the §63.0 body `{error, field?, detail?, blockers?}`. */
export class ScpRouteError extends HttpException {
  constructor(status: number, code: string, extra: { field?: string; detail?: Record<string, unknown>; blockers?: unknown[]; retryAfterSeconds?: number } = {}) {
    super({ message: code, ...extra }, status);
  }
}

export interface EffectRun {
  c: PoolClient;
  tenantId: string;
  actorId: string;
  action: string;
  postId: string;
  before: PipelinePostState;
  next: PipelinePostState;
  row: PostRow;
  engagement: EngagementRow;
  cycle: CycleRow | null;
  params: Record<string, unknown>;
  result: StageApplied;
  /** Filled by the effects, read by the service after the commit. */
  out: EffectOutput;
}

export interface EffectOutput {
  warnings: string[];
  filedApprovals: Array<{ id: string; input: FileApprovalInput }>;
  openedRequest: { id: string; title: string; toUnitId: string; toName: string; intake: { projectId: string; created: boolean } } | null;
  joinedRequestId: string | null;
  designId: string | null;
  clientToldOnce: boolean;
  /** Variant ids whose queued dispatch the service cancelled at the publisher before the transaction. */
  cancelledAtPublisher: Set<string>;
}

export const emptyOutput = (cancelled: Set<string> = new Set()): EffectOutput => ({
  warnings: [], filedApprovals: [], openedRequest: null, joinedRequestId: null, designId: null, clientToldOnce: false,
  cancelledAtPublisher: cancelled,
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The post row
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const JSONB_COLUMNS = new Set(["raw_assets", "suggestions", "copy_before"]);

/** The machine's `set`, as one UPDATE of the locked row (the engine status and pipeline_status in the same statement:
 *  BFF §63.3.5 "Engine status"). */
export async function updatePostRow(c: PoolClient, tenantId: string, postId: string, set: Record<string, unknown>, skipped: StageApplied["appendSkippedChecks"]): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [tenantId, postId];
  for (const [col, v] of Object.entries(set)) {
    if (col === "id") continue;
    vals.push(JSONB_COLUMNS.has(col) ? (v === null ? null : JSON.stringify(v)) : v);
    cols.push(`${col} = $${vals.length}${JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`);
  }
  if (skipped) {
    vals.push(JSON.stringify([skipped]));
    cols.push(`skipped_checks = skipped_checks || $${vals.length}::jsonb`);
  }
  if (!cols.length) return;
  await c.query(`UPDATE social_posts SET ${cols.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, vals);
}

/** The machine's `set` for create, as the INSERT of the new row. `created` is false when the id already existed. */
export async function insertPostRow(c: PoolClient, tenantId: string, engagementId: string, actorId: string, set: Record<string, unknown>): Promise<{ id: string; created: boolean }> {
  const id = typeof set.id === "string" ? set.id : newId();
  const row: Record<string, unknown> = {
    ...set, id, tenant_id: tenantId, engagement_id: engagementId, source: "human", created_by: actorId, origin_site: config.originSite,
  };
  const cols = Object.keys(row);
  const vals = cols.map((k) => (JSONB_COLUMNS.has(k) && row[k] !== null ? JSON.stringify(row[k]) : row[k]));
  const ph = cols.map((k, i) => `$${i + 1}${JSONB_COLUMNS.has(k) ? "::jsonb" : ""}`);
  const r = await c.query(`INSERT INTO social_posts (${cols.join(", ")}) VALUES (${ph.join(", ")}) ON CONFLICT (id) DO NOTHING`, vals);
  return { id, created: (r.rowCount ?? 0) > 0 };
}

export async function insertCopyLog(run: Pick<EffectRun, "c" | "tenantId" | "postId" | "actorId">, rows: StageApplied["copyLog"]): Promise<void> {
  for (const e of rows) {
    await run.c.query(
      `INSERT INTO social_post_copy_edits (tenant_id, post_id, field, before, after, via, suggested_by, edited_by, stage, origin_site)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [run.tenantId, run.postId, e.field, JSON.stringify(e.before ?? null), JSON.stringify(e.after ?? null), e.via, e.suggestedBy, run.actorId, e.stage, config.originSite],
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Variants from the master post (BFF §63.3.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The image/video kind and format of a stored file, from its content type (the composer's attach rule). */
function kindFormatOf(contentType: string | null): { kind?: "image" | "video"; format?: string } {
  if (!contentType) return {};
  const [type, sub] = contentType.toLowerCase().split("/");
  const kind = type === "image" ? "image" : type === "video" ? "video" : undefined;
  return { kind, format: sub === "jpg" ? "jpeg" : sub };
}

/** `settings.igType` follows the post's format (BFF §63.3.5): a reel is a Reel, a story a Story, the rest the feed. */
function settingsFor(network: string, format: string | null): Record<string, unknown> {
  if (network !== "instagram") return {};
  return { igType: format === "reel" ? "reel" : format === "story" ? "story" : "feed" };
}

/** The variant copy: the caption with the hashtags placed by the brand's `hashtag_strategy.placement` (body, or the first
 *  comment where the network has one). */
function copyFor(network: string, post: PipelinePostState, placement: string | undefined): { body: string; firstComment: string | null } {
  const tags = post.hashtags.filter((t) => t.trim()).map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  if (placement === "first_comment" && tags && isNetwork(network) && supportsFirstCommentFor(network)) {
    return { body: post.caption, firstComment: tags };
  }
  return { body: captionWithHashtags(post.caption, post.hashtags), firstComment: null };
}

/** Materialize each design's latest asset version once as a `files` row targeting the post, remembered on the design row;
 *  answer the variant media in design order. A link-only design has no file (the guard `designs_stored` refused it).
 *
 *  ⚠ CONTRACT GAP: BFF §63.3.5 names the file's `role` as `social_design`, but `files_role_check` (last re-declared by
 *  202610151720_client_reports.sql) does not allow that value and no SCP migration adds it, and a role file must also
 *  carry `sha256` (files_role_has_content), which a Studio asset does not record. The row is written with `role` NULL
 *  until a migration widens the CHECK; everything else is as the contract says. */
async function materializeDesignMedia(run: EffectRun): Promise<Array<Record<string, unknown>>> {
  const designs = await loadDesigns(run.c, run.tenantId, run.postId);
  const media: Array<Record<string, unknown>> = [];
  for (const d of designs) {
    if (!d.asset_version_id || !d.asset_graded_key) continue;
    let fileId = d.file_version_no === d.asset_version_no ? d.file_id : null;
    if (!fileId) {
      const existing = await run.c.query<{ id: string }>(
        `SELECT id FROM files WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2
            AND storage_key = $3 AND deleted_at IS NULL LIMIT 1`,
        [run.tenantId, run.postId, d.asset_graded_key],
      );
      fileId = existing.rows[0]?.id ?? newId();
      if (!existing.rows[0]) {
        await run.c.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
           VALUES ($1, $2, $3, 'social_post', $4, $5, $6, $7, $8, false, $9)`,
          [fileId, run.tenantId, run.actorId, run.postId, d.asset_name ?? "design", d.asset_content_type ?? "image/webp",
           Number(d.asset_graded_byte_size ?? 0), d.asset_graded_key, config.originSite],
        );
      }
      await run.c.query(`UPDATE social_post_designs SET file_id = $3, file_version_no = $4, thumb_file_id = NULL WHERE tenant_id = $1 AND id = $2`,
        [run.tenantId, d.id, fileId, d.asset_version_no]);
    }
    const kf = kindFormatOf(d.asset_content_type);
    media.push({ fileId, ...(kf.kind ? { kind: kf.kind } : {}), ...(kf.format ? { format: kf.format } : {}), alt: d.asset_name ?? undefined });
  }
  return media;
}

type SyncMode = "full" | "copy" | "dates";

/** Sync the variants from the master post. `full` (final_approve): one variant per placed network on the client's single
 *  account for it, created or updated in place (`UNIQUE (post_id, account_id)`, a soft-deleted one revived), content and
 *  media from the master; a network that left the placement is soft-deleted and its review withdrawn. `copy` (loop e):
 *  only body and first comment of the live variants. `dates` (reschedule): the date of the live variants, a new network
 *  added with the master's content, a dropped one removed. Every write recomputes `args_sha256` and the validation the way
 *  today's variant writes do, and drops the variant back to draft without an approval: the content (or its date) moved. */
export async function syncVariants(run: EffectRun, mode: SyncMode): Promise<string[]> {
  const post = run.next;
  const placementPref = typeof run.engagement.hashtag_strategy?.placement === "string" ? run.engagement.hashtag_strategy.placement : undefined;
  const existing = await loadVariants(run.c, run.tenantId, run.postId, true);
  const accounts = await loadClientAccounts(run.c, run.tenantId, run.engagement.client_id);
  const touched: string[] = [];
  const media = mode === "full" ? await materializeDesignMedia(run) : null;

  const write = async (v: { id: string; accountId: string; network: string; quota: Record<string, unknown>; body: string; firstComment: string | null; media: unknown[]; settings: Record<string, unknown>; scheduledAt: string | null }) => {
    if (!isNetwork(v.network)) throw new ScpRouteError(409, "no_account_for_network", { detail: { networks: [v.network] } });
    const network: Network = v.network;
    const shape = { body: v.body, firstComment: v.firstComment, media: v.media as never[], settings: v.settings, scheduledAt: v.scheduledAt };
    const validation = validateVariant(network, shape, v.quota);
    const cost = estimateCostUsd(network, shape, resolveXPricing());
    // SMM-22's rule: an unpriced X variant is refused, never written at a silent $0.
    if (!cost.ok) throw new ScpRouteError(409, "media_rules_failed", { detail: { variants: [{ variantId: v.id, errors: [{ rule: cost.reason }] }] } });
    const argsSha256 = variantArgsSha256({ tenantId: run.tenantId, id: v.id, accountId: v.accountId, ...shape });
    await run.c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, first_comment, media, settings, validation, args_sha256, scheduled_at,
          estimated_cost_usd, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, 'draft', $13)
       ON CONFLICT (post_id, account_id) DO UPDATE SET
         body = EXCLUDED.body, first_comment = EXCLUDED.first_comment, media = EXCLUDED.media, settings = EXCLUDED.settings,
         validation = EXCLUDED.validation, args_sha256 = EXCLUDED.args_sha256, scheduled_at = EXCLUDED.scheduled_at,
         estimated_cost_usd = EXCLUDED.estimated_cost_usd, status = 'draft', approval_id = NULL, deleted_at = NULL, updated_at = now()`,
      [v.id, run.tenantId, run.postId, v.accountId, v.body, v.firstComment, JSON.stringify(v.media), JSON.stringify(v.settings),
       JSON.stringify(validation), argsSha256, v.scheduledAt, cost.costUsd, config.originSite],
    );
    touched.push(v.id);
  };

  if (mode === "copy") {
    for (const e of existing) {
      const copy = copyFor(e.network, post, placementPref);
      await write({ id: e.id, accountId: e.account_id, network: e.network, quota: e.quota, body: copy.body, firstComment: copy.firstComment,
        media: e.media ?? [], settings: e.settings ?? {}, scheduledAt: e.scheduled_at ? new Date(e.scheduled_at).toISOString() : null });
    }
    return touched;
  }

  const placed = new Set(post.placement);
  for (const network of post.placement) {
    const account = (accounts.get(network) ?? [])[0];
    if (!account) throw new ScpRouteError(409, "no_account_for_network", { detail: { networks: [network] } });
    const current = existing.find((e) => e.account_id === account.id);
    const copy = copyFor(network, post, placementPref);
    // A revived (soft-deleted) or new variant: the master's content. `dates` keeps a live variant's content as it is.
    const keep = mode === "dates" && current;
    const siblingMedia = existing.find((e) => (e.media ?? []).length > 0)?.media ?? [];
    await write({
      id: current?.id ?? (await revivableId(run, account.id)) ?? newId(),
      accountId: account.id, network, quota: account.quota,
      body: keep ? current!.body : copy.body,
      firstComment: keep ? current!.first_comment : copy.firstComment,
      media: keep ? current!.media ?? [] : media ?? siblingMedia,
      settings: keep ? current!.settings ?? {} : settingsFor(network, post.format),
      scheduledAt: post.scheduledAt,
    });
  }
  // A network that left the placement: the variant goes, and so does its pending review.
  const dropped = existing.filter((e) => !placed.has(e.network));
  for (const e of dropped) {
    await run.c.query(`UPDATE social_post_variants SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`, [run.tenantId, e.id]);
  }
  if (dropped.length) await withdrawReviews(run, dropped.map((d) => d.id));
  return touched;
}

/** The id of the post's soft-deleted variant on this account, so a network that comes back revives its row (UNIQUE
 *  (post_id, account_id) holds across soft deletes). */
async function revivableId(run: EffectRun, accountId: string): Promise<string | null> {
  const r = await run.c.query<{ id: string }>(
    `SELECT id FROM social_post_variants WHERE tenant_id = $1 AND post_id = $2 AND account_id = $3`,
    [run.tenantId, run.postId, accountId],
  );
  return r.rows[0]?.id ?? null;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Client reviews
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Request (again) one client review per live variant: the upsert back to `pending`, every decision column reset, the six
 *  SCP columns included (BFF §63.1). Then the client is told once for the post (the existing
 *  `social.client_review.requested` event, with `postId` added), when the action's effects say to tell them. */
export async function requestReviews(run: EffectRun): Promise<void> {
  const variants = await loadVariants(run.c, run.tenantId, run.postId);
  let firstReviewId: string | null = null;
  for (const v of variants) {
    const r = await run.c.query<{ id: string }>(
      `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, requested_at, updated_at, origin_site)
       VALUES ($1, $2, $3, $4, 'pending', now(), now(), $5)
       ON CONFLICT (variant_id) DO UPDATE SET
         status = 'pending', comment = NULL, reviewed_args_sha256 = NULL, decided_by = NULL, decided_at = NULL,
         change_kind = NULL, anchor = NULL, recorded_by = NULL, channel = NULL, decision_id = NULL, undo_until = NULL,
         requested_at = now(), updated_at = now()
       RETURNING id`,
      [newId(), run.tenantId, v.id, run.engagement.client_id, config.originSite],
    );
    firstReviewId ??= r.rows[0].id;
  }
  const tellsClient = run.result.effects.some((e) => /^notify:client(_once_per_post)?$/.test(e));
  if (tellsClient && firstReviewId && variants[0] && !run.out.clientToldOnce) {
    await emitEvent(run.c, run.tenantId, "social_post_variant", variants[0].id, "social.client_review.requested", {
      reviewId: firstReviewId, clientId: run.engagement.client_id, projectId: run.engagement.project_id,
      postTitle: run.next.title, postId: run.postId,
    });
    run.out.clientToldOnce = true;
  }
}

/** Withdraw the pending reviews of these variants (or of every live variant). */
export async function withdrawReviews(run: Pick<EffectRun, "c" | "tenantId" | "postId" | "actorId">, variantIds?: string[]): Promise<void> {
  if (variantIds && !variantIds.length) return;
  await run.c.query(
    `UPDATE social_post_client_reviews r SET status = 'withdrawn', decided_by = $3, decided_at = now(), updated_at = now()
       FROM social_post_variants v
      WHERE r.variant_id = v.id AND r.tenant_id = v.tenant_id AND v.tenant_id = $1 AND v.post_id = $2 AND r.status = 'pending'
        ${variantIds ? "AND v.id = ANY($4::uuid[])" : ""}`,
    variantIds ? [run.tenantId, run.postId, run.actorId, variantIds] : [run.tenantId, run.postId, run.actorId],
  );
}

/** A decision the client gave outside the portal, recorded by staff on every pending review of the post in one statement:
 *  one shared `decision_id`, `recorded_by` and `channel` set, `decided_by` NULL (the client decided outside the ERP, BFF
 *  §63.1), and `reviewed_args_sha256` the variant's hash at this moment. */
async function recordDecision(run: EffectRun, status: "approved" | "changes_requested"): Promise<void> {
  const decisionId = newId();
  const anchor = run.params.anchor && typeof run.params.anchor === "object" ? JSON.stringify(run.params.anchor) : null;
  await run.c.query(
    `UPDATE social_post_client_reviews r
        SET status = $3, comment = $4, change_kind = $5, anchor = $6::jsonb, reviewed_args_sha256 = v.args_sha256,
            decision_id = $7, recorded_by = $8, channel = $9, decided_by = NULL, decided_at = now(), updated_at = now()
       FROM social_post_variants v
      WHERE r.variant_id = v.id AND r.tenant_id = v.tenant_id AND v.tenant_id = $1 AND v.post_id = $2 AND v.deleted_at IS NULL
        AND r.status = 'pending'`,
    [run.tenantId, run.postId, status, String(run.params.note ?? "").trim() || null,
     status === "changes_requested" ? run.params.changeKind : null, status === "changes_requested" ? anchor : null,
     decisionId, run.actorId, run.params.channel],
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The client-month Creatives request (BFF §63.6.6)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The post joins the cycle's month request, opening one when the cycle has none or its request is no longer open.
 *
 *  The request is an ordinary §32 asset request (§63.6.6): it is created by `createWorkRequestInTx`, the very function
 *  `POST requests` runs in its transaction, so the two cannot drift. The receiving unit's "request received" notification
 *  is sent after the commit by the service (`afterCommit`, from `out.openedRequest`), as it is for a hand-filed request. */
async function joinOrOpenMonthRequest(run: EffectRun): Promise<void> {
  if (!run.cycle) throw new ScpRouteError(404, "cycle_not_found");
  const cycle = await run.c.query<{ creative_request_id: string | null; status: string | null }>(
    `SELECT sc.creative_request_id::text AS creative_request_id, w.status
       FROM social_cycles sc LEFT JOIN work_requests w ON w.id = sc.creative_request_id
      WHERE sc.tenant_id = $1 AND sc.id = $2 FOR UPDATE OF sc`,
    [run.tenantId, run.cycle.id],
  );
  let requestId = cycle.rows[0]?.status === "open" ? cycle.rows[0].creative_request_id : null;
  if (!requestId) {
    const unit = await findDepartmentBySlug(run.c, run.tenantId, "creatives");
    if (!unit) throw new ScpRouteError(409, "creatives_unit_missing");
    const target = await run.c.query<{ posts_per_cycle: number | null }>(
      `SELECT posts_per_cycle FROM social_engagements WHERE tenant_id = $1 AND id = $2`, [run.tenantId, run.engagement.id]);
    const [y, m] = run.cycle.month.split("-").map(Number);
    const title = `${run.engagement.client_name} · ${MONTHS[m - 1]} ${y} social designs`.slice(0, 200);
    const form = wr.parseAssetsForm({
      deliverables: [{ format: "image", size: "per post", quantity: Math.max(1, Math.min(50, target.rows[0]?.posts_per_cycle ?? 1)) }],
      channel: "social",
      notes: `Designs for ${run.engagement.client_name}'s ${MONTHS[m - 1]} ${y} posts; each post lists its own brief.`,
    });
    // The §32 rule refusals (`to_unit_invalid`, `intake_project_unavailable`, a form or task the work item refuses) are
    // plain Errors, which would answer 500: map them to the refusal the caller reads, with the rule's own code.
    let created: Awaited<ReturnType<typeof wr.createWorkRequestInTx>>;
    try {
      created = await wr.createWorkRequestInTx(run.c, run.tenantId, run.actorId, {
        kind: "assets", toUnitId: unit.id, title, brief: "", neededBy: run.cycle.ready_by, campaignPartId: null, form,
      });
    } catch (e) {
      if (e instanceof wr.WorkRequestRuleError) throw new ScpRouteError(e.httpStatus, e.reason, e.field ? { field: e.field } : {});
      throw e;
    }
    requestId = created.id;
    await run.c.query(`UPDATE social_cycles SET creative_request_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [run.tenantId, run.cycle.id, requestId]);
    run.out.openedRequest = { id: requestId, title, toUnitId: unit.id, toName: created.toName, intake: created.intake };
  }
  await run.c.query(`UPDATE social_posts SET creative_request_id = $3 WHERE tenant_id = $1 AND id = $2`, [run.tenantId, run.postId, requestId]);
  run.out.joinedRequestId = requestId;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Designs (BFF §63.6.6)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

async function insertDesign(run: EffectRun): Promise<void> {
  const p = run.params;
  const groupId = typeof p.assetGroupId === "string" ? await resolveAssetGroup(run.c, run.tenantId, p.assetGroupId) : null;
  if (typeof p.assetGroupId === "string" && !groupId) throw new ScpRouteError(404, "asset_not_found");
  let position = typeof p.position === "number" ? p.position : null;
  if (position !== null) {
    // `ux_social_post_designs_position`, answered as the body error it is (designs only change under the post's lock).
    const taken = await run.c.query(
      `SELECT 1 FROM social_post_designs WHERE tenant_id = $1 AND post_id = $2 AND position = $3 AND removed_at IS NULL`, [run.tenantId, run.postId, position]);
    if (taken.rowCount) throw new ScpRouteError(400, "invalid_field", { field: "position" });
  }
  if (position === null) {
    const r = await run.c.query<{ n: number | null }>(
      `SELECT max(position) AS n FROM social_post_designs WHERE tenant_id = $1 AND post_id = $2 AND removed_at IS NULL`, [run.tenantId, run.postId]);
    position = (r.rows[0]?.n ?? 0) + 1;
    if (position > 20) throw new ScpRouteError(400, "invalid_field", { field: "position" });
  }
  const id = newId();
  await run.c.query(
    `INSERT INTO social_post_designs (id, tenant_id, post_id, position, asset_group_id, link_url, link_source, link_ai_note, added_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, run.tenantId, run.postId, position, groupId, groupId ? null : p.linkUrl ?? null, groupId ? null : p.linkSource ?? null,
     groupId ? null : p.linkAiNote ?? null, run.actorId, config.originSite],
  );
  run.out.designId = id;
}

/** An asset added on a `creatives` post is also linked to its month request (`ON CONFLICT DO NOTHING`). */
async function linkAssetToMonthRequest(run: EffectRun): Promise<void> {
  if (run.before.creativeSource !== "creatives" || !run.row.creative_request_id || typeof run.params.assetGroupId !== "string") return;
  const group = await resolveAssetGroup(run.c, run.tenantId, run.params.assetGroupId);
  if (!group) return;
  await run.c.query(
    `INSERT INTO work_request_assets (request_id, asset_id, tenant_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [run.row.creative_request_id, group, run.tenantId, run.actorId],
  );
}

async function markDesignRemoved(run: EffectRun): Promise<void> {
  await run.c.query(
    `UPDATE social_post_designs SET removed_at = now(), removed_by = $4 WHERE tenant_id = $1 AND post_id = $2 AND id = $3 AND removed_at IS NULL`,
    [run.tenantId, run.postId, run.params.designId, run.actorId],
  );
}

/** A design whose source was left `unknown` is a warning, never a refusal (BFF §63.6.6). A link carries its own source; an
 *  asset's is the latest live version's on `creative_assets` (SCP-1h, file 4), set where the asset is saved. */
async function warnOnUnknownSource(run: EffectRun): Promise<void> {
  const designs = await loadDesigns(run.c, run.tenantId, run.postId);
  const unknown = designs.some((d) => (d.link_url !== null ? d.link_source === "unknown" : d.asset_version_id !== null && d.asset_source === "unknown"));
  if (unknown) run.out.warnings.push("design_source_unknown");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Publishing: approvals, dispatches, going live (BFF §63.10)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** One D14 publish approval per variant, through SMM-40's filing helper, bound to the approved content (the variant's
 *  args). The variant moves to `approved` as `POST variants/:id/approve` does; a second person decides each row. */
async function filePublishApprovals(run: EffectRun): Promise<void> {
  const variants = await loadVariants(run.c, run.tenantId, run.postId, true);
  for (const v of variants) {
    const args = variantPublishArgs({
      tenantId: run.tenantId, id: v.id, accountId: v.account_id, body: v.body, firstComment: v.first_comment, media: v.media,
      settings: v.settings, scheduledAt: v.scheduled_at,
    });
    await run.c.query(`UPDATE social_post_variants SET status = 'approved', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('draft','in_review')`,
      [run.tenantId, v.id]);
    const id = newId();
    const input: FileApprovalInput = {
      tenantId: run.tenantId, workflowId: "social:publish-variant", toolName: SOCIAL_PUBLISH_TOOL,
      toolArgs: args as unknown as Record<string, unknown>, impact: SOCIAL_PUBLISH_TOOL_CLASSIFICATION.impact,
      reason: `Publish approval requested for post variant ${v.id}`, origin: "agent", requestedBy: run.actorId,
    };
    await insertAutomationApprovalRow(run.c, id, input);
    run.out.filedApprovals.push({ id, input });
  }
}

/** Take the post off its schedule: undecided publish approvals withdrawn (`cancelled`: nobody refused them), the variants
 *  back to draft without an approval (so a decided-but-unexecuted grant now refuses `variant_not_approved` at the
 *  precondition), and a queued dispatch only when the service already cancelled it at the publisher. A variant
 *  mid-publish, or queued and not cancelled, is 409 `dispatch_in_flight`. */
async function unscheduleVariants(run: EffectRun): Promise<void> {
  const variants = await loadVariants(run.c, run.tenantId, run.postId, true);
  const inFlight = variants.filter((v) => v.status === "publishing" || (v.status === "queued" && !run.out.cancelledAtPublisher.has(v.id)));
  if (inFlight.length) throw new ScpRouteError(409, "dispatch_in_flight");
  await withdrawApprovals(run);
  await run.c.query(
    `UPDATE social_post_variants SET status = 'draft', approval_id = NULL, provider_post_id = NULL, updated_at = now()
      WHERE tenant_id = $1 AND post_id = $2 AND deleted_at IS NULL AND status IN ('approved','queued','failed','cancelled')`,
    [run.tenantId, run.postId],
  );
}

/** Withdraw the post's undecided publish approvals. */
async function withdrawApprovals(run: Pick<EffectRun, "c" | "tenantId" | "postId">): Promise<void> {
  await run.c.query(
    `UPDATE automation_approvals SET status = 'cancelled', updated_at = now()
      WHERE tenant_id = $1 AND tool_name = $3 AND status = 'pending' AND deleted_at IS NULL
        AND tool_args->>'variantId' IN (SELECT id::text FROM social_post_variants WHERE tenant_id = $1 AND post_id = $2)`,
    [run.tenantId, run.postId, SOCIAL_PUBLISH_TOOL],
  );
}

/** Posted by hand: each variant becomes a native-import bookkeeping row (`native_import`, `published`, no approval, no
 *  provider id), 0105's law for "posted by hand" (`svar_native_import_is_bookkeeping`). */
async function variantsPostedByHand(run: EffectRun): Promise<void> {
  const url = String(run.params.url);
  const at = typeof run.params.at === "string" ? run.params.at : new Date().toISOString();
  await run.c.query(
    `UPDATE social_post_variants
        SET native_import = true, status = 'published', approval_id = NULL, provider_post_id = NULL,
            published_url = $3, published_at = $4, updated_at = now()
      WHERE tenant_id = $1 AND post_id = $2 AND deleted_at IS NULL`,
    [run.tenantId, run.postId, url, at],
  );
}

/** Before the transaction (no row lock across a network call): cancel each queued dispatch of the post at the publisher,
 *  through the same org-handle resolution the dispatch used. Answers the variant ids cancelled; a cancel that fails leaves
 *  its variant queued, and the transaction then refuses 409 `dispatch_in_flight`. */
export async function cancelQueuedDispatchesBeforeTx(tenantId: string, postId: string): Promise<Set<string>> {
  const queued = await withTenants([tenantId], (c) => c.query<{ id: string; provider_post_id: string | null }>(
    `SELECT id, provider_post_id FROM social_post_variants WHERE tenant_id = $1 AND post_id = $2 AND deleted_at IS NULL AND status = 'queued'`,
    [tenantId, postId],
  ), { modules: ["social"] });
  const done = new Set<string>();
  for (const v of queued.rows) {
    if (!v.provider_post_id) continue;
    try {
      const chain = await withTenants([tenantId], (c) => assertDispatchChain(c, v.id), { modules: ["social"] });
      const { driver, handle } = await resolveDispatchOrgHandle(tenantId, chain, "cancel");
      await driver.cancelPost(handle, v.provider_post_id);
      done.add(v.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[scp] cancelling the queued dispatch of variant ${v.id} failed: ${(err as Error)?.message ?? err}`);
    }
  }
  return done;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The registry
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const noop = async (): Promise<void> => {};

/** Every I/O effect the fixture names, by name. A no-op hook names the ticket that fills it. */
export const EFFECT_RUNNERS: Record<string, (run: EffectRun) => Promise<void>> = {
  // ── later tickets ──
  set_simulated_from_variants: noop, // SCP-Sa: `simulated` comes from the variants once file 8 adds the column
  start_metrics: noop, // SCP-3c: metrics start when the post is live
  from_published_variants: noop, // SCP-3b: the publisher's own result path (systemRules publisher_results)
  reviews_back_to_pending: noop, // SCP-2: client_undo, a portal route
  drop_pending_notifications: noop, // SCP-2
  undo_window_10s: noop, // SCP-2: the portal decision's undo window
  activity_only: noop, // follow_up writes only its activity row (after the commit)
  enter_in_team_queue: noop, // the queue is the posts in `design` with creative_source in_team (BFF §63.6.6)
  schedule_by_hand_at_approved_date_time_and_placement: noop, // "Schedule in Meta": nothing changes but the status
  decision_id: noop, // written by the decision effect itself (one shared id)
  recorded_by_and_channel: noop, // written by the decision effect itself
  // ── copy log (rows from the machine's `copyLog`) ──
  copy_log_when_in_changes: noop, // the service inserts `copyLog` once, for every action
  copy_log: noop,
  copy_log_each_field: noop,
  // ── variants and reviews ──
  sync_variants_copy_from_master: async (run) => { await syncVariants(run, "copy"); },
  sync_variants_from_master: async (run) => { await syncVariants(run, "full"); },
  materialize_design_files: noop, // inside sync_variants_from_master, which needs the media first
  sync_variants_dates_and_networks: async (run) => { await syncVariants(run, "dates"); },
  request_client_reviews: requestReviews,
  request_client_reviews_on_every_variant: requestReviews,
  approve_every_variant_review_with_args_hash_in_one_transaction: (run) => recordDecision(run, "approved"),
  changes_requested_on_every_variant_review_in_one_transaction: (run) => recordDecision(run, "changes_requested"),
  withdraw_pending_client_reviews: (run) => withdrawReviews(run),
  // ── the content-month PM task (SCP-1n, BFF §63.13): its progress, done and reopen follow the cycle's posts, one direction only ──
  content_month_progress: async (run) => { if (run.row.cycle_id) await syncContentMonthProgress(run.c, run.tenantId, run.row.cycle_id, run.actorId || null); },
  // ── the month request and designs ──
  join_or_open_month_request: joinOrOpenMonthRequest,
  insert_design: insertDesign,
  link_asset_to_month_request: linkAssetToMonthRequest,
  mark_design_removed: markDesignRemoved,
  warn_on_unknown_source: warnOnUnknownSource,
  // ── publishing ──
  file_one_publish_approval_per_variant: filePublishApprovals,
  cancel_queued_dispatches_and_withdraw_pending_approvals: unscheduleVariants,
  unschedule_cancelling_dispatches_and_withdrawing_approvals: unscheduleVariants,
  withdraw_pending_publish_approvals: (run) => withdrawApprovals(run),
  variants_become_native_import_published: variantsPostedByHand,
};

/** Notifications run after the commit (pipeline.service.ts), by their `notify:` names. */
export const isNotification = (name: string) => /^notify(_after_undo_window)?:/.test(name);

/** Fail at load when the fixture names an effect that neither the machine realizes in its `set` (`COLUMN_EFFECTS`) nor
 *  this file runs, or that this file runs and the fixture no longer names. */
export function assertEffectCoverage(): void {
  const problems: string[] = [];
  const named = new Set<string>();
  for (const a of SCP.actions) {
    for (const raw of a.effects) {
      const { name } = splitEffect(raw);
      named.add(name);
      if (isNotification(name)) continue;
      if (!(name in EFFECT_RUNNERS) && !(name in COLUMN_EFFECTS)) problems.push(`${a.action}: '${name}' has no runner`);
    }
  }
  for (const k of Object.keys(EFFECT_RUNNERS)) if (!named.has(k)) problems.push(`runner '${k}' is not a fixture effect`);
  if (problems.length) throw new Error(`SCP effects out of step with the fixture:\n  - ${problems.join("\n  - ")}`);
}
assertEffectCoverage();
