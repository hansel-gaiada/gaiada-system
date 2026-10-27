// SCP-3b server half, built by SCP-Sc — the publisher's result on a pipeline post (FRONTEND-BFF-CONTRACT §63.10 "The publisher's
// result", fixture `systemRules` `publisher_results` and `publisher_failure`, action `mark_live`'s `publisher` actor).
//
// WHAT IT DOES. A pipeline post scheduled THROUGH THE PUBLISHER (`schedule_via = 'publisher'`) has one variant per placed
// network. The variants move on their own, through `dispatch.ts` (a refusal at dispatch) and `post-status-sync-job.ts` (the
// network's authoritative answer). After each of those writes, this file looks at the post:
//
//   every live variant `published`  ->  the machine's `mark_live` as the PUBLISHER actor: the post is `live`, its `live_url` is
//                                       the first published variant's link, `went_live_at` the time the last one went out,
//                                       `simulated` follows the variants, one `mark_live` activity row (no person), and the
//                                       officer is told once.
//   a variant `failed`              ->  the post STAYS `scheduled` and its engine status becomes `failed` (the fixture's engine
//                                       status override), which the Failed posts tile counts (§63.7 `failedPosts`); one
//                                       `publisher_failed` activity row the first time. An approver may then unschedule it, or
//                                       the officer reschedule it (the post's own actions[], unchanged).
//   anything else                   ->  nothing: some variant is still queued or in flight.
//
// A Composer post (no `pipeline_status`) and a post scheduled by hand are never candidates (`CANDIDATES_SQL`), so today's
// behaviour for both is untouched.
//
// ── A SYSTEM PATH: NO PERSON, NO CERBOS ────────────────────────────────────────────────────────────────────────────────
// The actor is the machine's `publisher` (`StagePrincipal.isPublisher`): `decide()` skips the person checks (automation,
// maker/checker, Cerbos) for it and refuses it every action whose `actors` does not name it (only `mark_live` does). There is
// no principal here, no `authorize()` and no audit-as-a-person: the actor of the activity row is NULL, exactly like the
// status sweep's own `published`/`failed` rows. The trust is in WHO CAN CALL THIS: only code that has just written a
// variant's terminal status from a network answer (dispatch.ts, post-status-sync-job.ts) or the simulated "Publish now"
// route, which itself authorizes `approve` first. This file takes no request, so no HTTP caller can name a post.
//
// ── EXACTLY ONCE, AND IDEMPOTENT ───────────────────────────────────────────────────────────────────────────────────────
// Each candidate is settled in ONE transaction that locks the post row `FOR UPDATE` and re-reads everything under the lock.
//   * going live is `decide()` in `apply` mode against the LOCKED post: a post that is no longer `scheduled` (already live,
//     unscheduled, archived) is not a candidate under the lock and nothing is written, so a second call, a concurrent one, a
//     replayed reconcile and the self-heal below all find the post live and do nothing. The row UPDATE, the effects and the
//     variants' re-check (`variantsMustBePublished`) share that transaction, so the post is live or it is not.
//   * the activity row and the officer's notification are written AFTER the commit, and only by the call whose transaction
//     applied the change, so each exists once. (A crash between the commit and the activity row loses the row, as it does for
//     every stage action: the post itself is right.)
//   * the failure's engine status is a guarded UPDATE (`status IS DISTINCT FROM`): only the call that changed it writes the
//     activity row, so a second failed variant or a repeat of the same one writes nothing.
//   * SELF-HEAL: the variants' terminal write and this file are two transactions. A crash between them would leave a post
//     whose variants are all published and which is not live, and the variants would never be looked at again (they are no
//     longer in flight). `settlePublisherResults(tenantId)` with no ids, run at the end of every tenant reconcile, finds such
//     posts and settles them.
//
// It never throws to its callers: the variant's own terminal write has already committed by the time it runs, and a failure
// here must not turn a stamped dispatch into an error answer or abort a sweep over other posts. Failures are logged and the
// next reconcile retries (the self-heal).
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { notify, writeActivity } from "../../../core/http";
import { decide, engineStatusOf, type StageApplied } from "./machine";
import { emptyOutput, EFFECT_RUNNERS, isNotification, updatePostRow, type EffectRun } from "./pipeline-effects";
import {
  findDepartmentBySlug, loadCycle, loadEngagement, loadPostRow, loadVariants, stateOf, type EngagementRow, type VariantRow,
} from "./pipeline-data";

const SOCIAL = { modules: ["social"] };

// ── The decision (pure) ───────────────────────────────────────────────────────────────────────────────────────────────

export type PublisherResult =
  | { kind: "live"; liveUrl: string; at: string; simulated: boolean }
  /** Every variant is published, but none reported a link: the post cannot go live without one (`live_url` is the post's
   *  link, §63.10), and inventing one would be worse than waiting. Logged by the caller; the officer's `mark_live` with a link
   *  is the way out. Never reached by the simulator, whose every published variant has a `simulated.invalid` link. */
  | { kind: "no_link" }
  | { kind: "failed" }
  | { kind: "waiting" };

/** What the publisher's results say about a post, from its live variants in `loadVariants` order (network, id). PURE.
 *  A failed variant wins over everything (the fixture: "a variant of a scheduled post fails -> the post stays scheduled"),
 *  even when its siblings published: a post is live only when EVERY variant is. */
export function publisherResultOf(variants: ReadonlyArray<Pick<VariantRow, "status" | "published_url" | "published_at" | "simulated">>): PublisherResult {
  if (variants.length === 0) return { kind: "waiting" };
  if (variants.some((v) => v.status === "failed")) return { kind: "failed" };
  if (!variants.every((v) => v.status === "published")) return { kind: "waiting" };
  const first = variants.find((v) => typeof v.published_url === "string" && v.published_url !== "");
  if (!first) return { kind: "no_link" };
  // The post went live when the LAST of its variants went out.
  const times = variants.map((v) => (v.published_at ? new Date(v.published_at).getTime() : NaN)).filter((t) => Number.isFinite(t));
  const at = new Date(times.length ? Math.max(...times) : Date.now()).toISOString();
  return { kind: "live", liveUrl: first.published_url as string, at, simulated: variants.some((v) => v.simulated === true) };
}

// ── The candidates ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Posts a variant's terminal write can have moved: scheduled through the publisher, not deleted or archived. `$2` is the list
 *  of variant ids that just changed, or NULL for the tenant-wide self-heal, which looks only at posts that have something to
 *  settle (a variant at rest as published or failed) and skips a post already marked failed with a failed variant. */
const CANDIDATES_SQL = `
  SELECT DISTINCT p.id::text AS id
    FROM social_posts p
   WHERE p.tenant_id = $1 AND p.pipeline_status = 'scheduled' AND p.schedule_via = 'publisher'
     AND p.deleted_at IS NULL AND p.archived_at IS NULL
     AND ($2::text[] IS NULL OR EXISTS (
           SELECT 1 FROM social_post_variants v WHERE v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.id::text = ANY($2::text[])))
     AND EXISTS (
           SELECT 1 FROM social_post_variants v
            WHERE v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL AND v.status IN ('published', 'failed'))
     AND ($2::text[] IS NOT NULL OR NOT (p.status = 'failed' AND EXISTS (
           SELECT 1 FROM social_post_variants v WHERE v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL AND v.status = 'failed')))`;

export interface SettleSummary {
  live: string[];
  failed: string[];
  errors: number;
}

/**
 * Settle the pipeline posts that the given variants (or, with none, the whole tenant's) belong to. Idempotent and never
 * throws (the header). Answers which posts went live and which were newly marked failed, for the callers' tests and logs.
 */
export async function settlePublisherResults(tenantId: string, opts: { variantIds?: string[] } = {}): Promise<SettleSummary> {
  const out: SettleSummary = { live: [], failed: [], errors: 0 };
  let ids: string[];
  try {
    const ofVariants = opts.variantIds && opts.variantIds.length > 0 ? opts.variantIds : null;
    if (opts.variantIds && opts.variantIds.length === 0) return out; // nothing changed: nothing to settle
    const found = await withTenants([tenantId], (c) => c.query<{ id: string }>(CANDIDATES_SQL, [tenantId, ofVariants]), SOCIAL);
    ids = found.rows.map((r) => r.id);
  } catch (err) {
    out.errors += 1;
    // eslint-disable-next-line no-console
    console.error(`[SCP-PUBLISHER-RESULT] tenant ${tenantId}: could not list posts to settle:`, (err as Error)?.message ?? err);
    return out;
  }
  for (const postId of ids) {
    try {
      const r = await settleOnePost(tenantId, postId);
      if (r === "live") out.live.push(postId);
      else if (r === "failed") out.failed.push(postId);
    } catch (err) {
      out.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SCP-PUBLISHER-RESULT] post ${postId} (tenant ${tenantId}) failed:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

// ── One post ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type Settled =
  | { kind: "skip" }
  | { kind: "failed"; engagement: EngagementRow; cycleId: string | null; changed: boolean }
  | { kind: "live"; applied: StageApplied; engagement: EngagementRow; cycleId: string | null; simulated: boolean };

/** `live`: this call put the post live. `failed`: this call changed the post's engine status to failed. `none`: nothing to do. */
export async function settleOnePost(tenantId: string, postId: string): Promise<"live" | "failed" | "none"> {
  const r = await withTenants([tenantId], (c) => settleInTx(c, tenantId, postId), SOCIAL);
  if (r.kind === "skip") return "none";

  if (r.kind === "failed") {
    if (!r.changed) return "none";
    await writeActivity(tenantId, null, "publisher_failed", "social_post", postId, {
      from: "scheduled", to: "scheduled", engineStatus: "failed", cycleId: r.cycleId, engagementId: r.engagement.id, viaPortal: false, viaPublisher: true,
    });
    return "failed";
  }

  // The activity row of a stage action (BFF §63.14): verb `mark_live`, no person. `viaPublisher` says who; `via` is
  // `writeActivity`'s own agent stamp and is not used here. The row carries no link and no text.
  await writeActivity(tenantId, null, r.applied.action, "social_post", postId, {
    ...r.applied.activity.metadata, cycleId: r.cycleId, engagementId: r.engagement.id, viaPortal: false, viaPublisher: true, simulated: r.simulated,
  });
  try {
    await notifyOfficerWentLive(tenantId, postId, r.engagement, r.simulated);
  } catch (err) {
    // A notification never undoes the action (BFF §63.14).
    // eslint-disable-next-line no-console
    console.error(`[SCP-PUBLISHER-RESULT] notification for ${postId} failed:`, (err as Error)?.message ?? err);
  }
  return "live";
}

async function settleInTx(c: PoolClient, tenantId: string, postId: string): Promise<Settled> {
  const row = await loadPostRow(c, tenantId, postId, true);
  // Under the lock: the post must still be a publisher-scheduled pipeline post at rest in `scheduled`.
  if (!row || row.deleted_at !== null || row.archived_at !== null || row.pipeline_status !== "scheduled" || row.schedule_via !== "publisher") {
    return { kind: "skip" };
  }
  const state = stateOf(row)!;
  const variants = await loadVariants(c, tenantId, postId);
  const result = publisherResultOf(variants);
  if (result.kind === "waiting") return { kind: "skip" };
  if (result.kind === "no_link") {
    // eslint-disable-next-line no-console
    console.warn(`[SCP-PUBLISHER-RESULT] post ${postId} (tenant ${tenantId}): every variant is published but none has a link, so it stays scheduled (an officer can mark it live with the link)`);
    return { kind: "skip" };
  }
  const engagement = await loadEngagement(c, tenantId, row.engagement_id);
  if (!engagement) return { kind: "skip" };
  const cycle = row.cycle_id ? await loadCycle(c, tenantId, row.cycle_id) : null;
  const cycleId = cycle?.id ?? null;

  if (result.kind === "failed") {
    // `publisher_failure`: the post stays scheduled; only its engine status changes, by the fixture's own override
    // (`scheduled` + a failed variant -> `failed`), in a guarded UPDATE so a repeat changes nothing.
    const engineStatus = engineStatusOf(state, variants.map((v) => v.status), false);
    const upd = await c.query(
      `UPDATE social_posts SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status IS DISTINCT FROM $3`,
      [tenantId, postId, engineStatus],
    );
    return { kind: "failed", engagement, cycleId, changed: (upd.rowCount ?? 0) > 0 };
  }

  // `publisher_results`: mark_live as the publisher, in this transaction, by the machine's own decision.
  const now = new Date();
  const r = decide({
    action: "mark_live", params: { at: result.at }, post: state, cerbos: {}, mode: "apply", requireExpectedStatus: false,
    principal: { isAutomation: false, isAuthor: false, isOfficer: false, isPublisher: true },
    facts: {
      now, variantStatuses: variants.map((v) => v.status), anyVariantPublishing: variants.some((v) => v.status === "publishing"),
      publisherLiveUrl: result.liveUrl,
    },
  });
  if (!r.ok) {
    // A refusal here means the rows changed under the lock in a way the candidate query could not see (a variant moving to
    // `publishing`): not an error, the next result retries.
    // eslint-disable-next-line no-console
    console.warn(`[SCP-PUBLISHER-RESULT] post ${postId} (tenant ${tenantId}): mark_live refused: ${r.code}`);
    return { kind: "skip" };
  }
  if (r.alreadyApplied) return { kind: "skip" };

  await updatePostRow(c, tenantId, postId, r.set, r.appendSkippedChecks);
  const out = emptyOutput();
  const run: EffectRun = {
    c, tenantId, actorId: "", action: "mark_live", postId, before: state, next: r.next ?? state, row, engagement, cycle,
    params: { at: result.at }, result: r, out,
  };
  for (const name of r.effects) {
    if (isNotification(name)) continue;
    await EFFECT_RUNNERS[name](run);
  }
  return { kind: "live", applied: r, engagement, cycleId, simulated: result.simulated };
}

/** The fixture's `notify:officer_when_by_publisher`: the client's officer hears the post went live. §63.14 names no type for it,
 *  so `social.post.went_live` is new (a contract gap, reported with the ticket). Never to a person who acted: nobody did. */
async function notifyOfficerWentLive(tenantId: string, postId: string, engagement: EngagementRow, simulated: boolean): Promise<void> {
  if (!engagement.owner_id) return;
  const dept = await withTenants([tenantId], (c) => findDepartmentBySlug(c, tenantId, "social-media"));
  await notify(tenantId, engagement.owner_id, null, "social.post.went_live", {
    title: simulated ? "A post went live (simulated)" : "A post went live",
    ...(dept ? { href: `/departments/${dept.id}/posts/${postId}` } : {}),
    entityType: "social_post", entityId: postId, severity: "info", action: "mark_live", simulated,
  });
}
