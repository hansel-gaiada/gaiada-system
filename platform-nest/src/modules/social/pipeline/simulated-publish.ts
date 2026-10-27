// SCP-Sc — "Publish now (simulated)": `POST posts/:postId/simulated-publish-now` (BFF §63.10, plan §5 "Publish now (simulated) is
// available too"), and the read's `simulatedPublishNow` that tells the post page whether to draw its button.
//
// WHAT IT IS. A pipeline post scheduled through the publisher on SIMULATED accounts has, once its publish approvals are decided
// and executed, queued variants whose publish time is the approved date (`simulated:<network>:<publishAtMs>:<uuid>`,
// simulated-driver.ts). "Publish now" moves that time up to the present and then runs the very reconcile the due job runs, so
// the post goes live through the same `post-status-sync-job.ts` apply and the same `publisher-result.ts` settle as at its time.
// Nothing about the publish itself is shortcut.
//
// WHAT IT NEVER DOES (Sa's fences, simulation.ts's header, fence 5):
//   * it never mints, files, decides or re-opens an approval: it READS `automation_approvals` and refuses
//     409 `simulated_approval_not_decided` unless every variant holds a DECIDED publish approval;
//   * it never dispatches: a variant whose decided approval has not been executed yet (still `approved`, or `failed`) is
//     409 `simulated_not_dispatched`: the D14 executor owns that step and a second dispatch would need an approval this
//     route may not create. So "re-dispatch" is not offered; what is offered is the time of what the executor already queued;
//   * it never reaches the simulator itself: the id's new time comes from `advanceSimulatedPostId` (the driver's own
//     format code), the status read is `reconcileOneProviderPost` (the status sweep's own on-ramp, which resolves the
//     simulator through `resolveSimulatedPublisher` and refuses `simulation_disabled` with the switch off), and it adds no
//     caller of `resolveSimulatedPublisher` (simulation.test.ts pins the two there are);
//   * it never writes a `simulated` mark: the UPDATE below changes `provider_post_id` and nothing else (simulation.test.ts pins
//     that the dispatch stamp is the ONLY statement that writes a variant's mark, so this SQL must not mention it).
//
// WHO. One of the four (`social_post` · `approve`, PERMISSION §53): the post's author and officer are denied by the maker/checker
// DENY on `approve` itself, so the officer is refused here (403) with no rule restated in this file. An unattended automation is
// refused 403 `automation_cannot_act` (§63.15). Authorization first; then 404/409 in the order of the codes below.
//
// ORDER OF ANSWERS: 404 `post_not_found` · 403 (automation, then Cerbos `approve`) · 409 `not_a_pipeline_post` · 409
// `simulation_disabled` · (under the post's lock) 409 `not_scheduled_by_publisher` · 409 `simulated_account_required` · 409
// `simulated_approval_not_decided` · 409 `simulated_not_dispatched`.
//
// IDEMPOTENT. A second click finds the ids already due (`advanceSimulatedPostId` never moves a time later) or the variants
// already published, rewrites nothing, and the reconcile and the settle are idempotent (post-status-sync-job.ts, publisher-result.ts).
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import type { Principal } from "../../../rbac/principal";
import { loadSocialPostAuthz, socialPostResource } from "../pipeline-authz";
import { SOCIAL_PUBLISH_METERED_TOOL, SOCIAL_PUBLISH_TOOL } from "../publish-precondition";
import { reconcileOneProviderPost } from "../post-status-sync-job";
import { advanceSimulatedPostId } from "../publisher/simulated-driver";
import { SOCIAL_SIMULATION_REFUSAL, isSocialSimulationEnabled } from "../publisher/simulation";
import { loadPostRow, loadVariants, type PostRow, type VariantRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import { settlePublisherResults } from "./publisher-result";

const SOCIAL = { modules: ["social"] };

/** The codes this file adds. The other three it answers are Sa's (`SOCIAL_SIMULATION_REFUSAL`) and the post machine's. */
export const SIMULATED_PUBLISH_REFUSAL = {
  /** The post is not `scheduled`, or was scheduled by hand, or has no variants (409). */
  notScheduledByPublisher: "not_scheduled_by_publisher",
  /** A variant's decided approval has not been executed into a queued dispatch yet, or its dispatch failed (409). */
  notDispatched: "simulated_not_dispatched",
} as const;

type Judged = { ok: true } | { ok: false; code: string; detail?: Record<string, unknown> };

/**
 * PURE. Whether "publish now" may proceed, from the rows, in the order of the header. `decided` is the set of variant ids that
 * hold a DECIDED publish approval (`decidedVariantIds`). A variant at rest as `published` needs nothing more; a `queued` one
 * is the one whose time moves.
 */
export function judgeSimulatedPublish(input: {
  pipelineStatus: string | null;
  scheduleVia: string | null;
  variants: ReadonlyArray<Pick<VariantRow, "id" | "status" | "account_simulated" | "native_import">>;
  decided: ReadonlySet<string>;
}): Judged {
  const live = input.variants.filter((v) => !v.native_import);
  if (input.pipelineStatus !== "scheduled" || input.scheduleVia !== "publisher" || live.length === 0) {
    return { ok: false, code: SIMULATED_PUBLISH_REFUSAL.notScheduledByPublisher };
  }
  if (live.some((v) => v.account_simulated !== true)) {
    return { ok: false, code: SOCIAL_SIMULATION_REFUSAL.accountNotSimulated };
  }
  const undecided = live.filter((v) => !input.decided.has(v.id)).map((v) => v.id);
  if (undecided.length) return { ok: false, code: SOCIAL_SIMULATION_REFUSAL.approvalNotDecided, detail: { variantIds: undecided } };
  const notReady = live.filter((v) => v.status !== "queued" && v.status !== "published");
  if (notReady.length) {
    return { ok: false, code: SIMULATED_PUBLISH_REFUSAL.notDispatched, detail: { variants: notReady.map((v) => ({ id: v.id, status: v.status })) } };
  }
  return { ok: true };
}

/** The variants (of `variantIds`) that hold a DECIDED publish approval: the same fact the simulator's own guard reads
 *  (`dbSimulatedDispatchGuard`): approved, with a decider and a time, either publish tool. Read-only. */
async function decidedVariantIds(c: PoolClient, tenantId: string, variantIds: string[]): Promise<Set<string>> {
  if (!variantIds.length) return new Set();
  const r = await c.query<{ variant_id: string }>(
    `SELECT DISTINCT tool_args->>'variantId' AS variant_id
       FROM automation_approvals
      WHERE tenant_id = $1 AND tool_name = ANY($2::text[]) AND status = 'approved'
        AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND deleted_at IS NULL
        AND tool_args->>'variantId' = ANY($3::text[])`,
    [tenantId, [SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL], variantIds],
  );
  return new Set(r.rows.map((x) => x.variant_id));
}

// ── The read ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SimulatedPublishOffer {
  /** The caller may press the button now. */
  allowed: boolean;
  /** When not allowed: the refusal code the click would answer (`not_an_approver` first, as the caller cannot change it). */
  reason?: string;
}

/**
 * `PipelinePost.simulatedPublishNow`: null when the button is not part of this post's page (the switch is off, the post is not
 * scheduled through the publisher, or its accounts are not simulated: it is not a simulated publish at all); else whether the
 * caller may press it, and why not. `approve` is the caller's Cerbos answer for the post (the read asks it). Reads only.
 */
export async function readSimulatedPublishOffer(
  c: PoolClient, tenantId: string, row: PostRow, approve: boolean | undefined,
): Promise<SimulatedPublishOffer | null> {
  if (!isSocialSimulationEnabled()) return null;
  if (row.pipeline_status !== "scheduled" || row.schedule_via !== "publisher") return null;
  const variants = await loadVariants(c, tenantId, row.id);
  const decided = await decidedVariantIds(c, tenantId, variants.map((v) => v.id));
  const j = judgeSimulatedPublish({ pipelineStatus: row.pipeline_status, scheduleVia: row.schedule_via, variants, decided });
  if (!j.ok && (j.code === SIMULATED_PUBLISH_REFUSAL.notScheduledByPublisher || j.code === SOCIAL_SIMULATION_REFUSAL.accountNotSimulated)) return null;
  if (approve !== true) return { allowed: false, reason: "not_an_approver" };
  return j.ok ? { allowed: true } : { allowed: false, reason: j.code };
}

// ── The route ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SimulatedPublishOutcome {
  postId: string;
  /** Variants whose publish time was moved up to now (already-due and already-published ones are not counted). */
  advanced: number;
  /** Whether the post is live after the reconcile. */
  live: boolean;
}

export async function simulatedPublishNow(principal: Principal, tenantId: string, postId: string): Promise<SimulatedPublishOutcome> {
  // 1. The rows Cerbos must see (as `readPipelinePost` reads them).
  const pre = await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId);
    const authz = row && row.deleted_at === null ? await loadSocialPostAuthz(c, tenantId, postId) : null;
    return { row, authz };
  }, SOCIAL);
  if (!pre.row || pre.row.deleted_at !== null || !pre.authz) throw new ScpRouteError(404, "post_not_found");

  // 2. Authorization before anything else is judged. `authorize()` audits a denial, intersects an acting-for persona, and ends
  //    on the revoked-session check. `approve` carries the maker/checker DENY: the post's author and officer are refused.
  if (principal.kind === "automation" || principal.kind === "bot") throw new ScpRouteError(403, "automation_cannot_act");
  await authorize(principal, socialPostResource(tenantId, pre.authz), "approve");
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");

  // 3. The post and the switch.
  if (pre.row.pipeline_status === null) throw new ScpRouteError(409, "not_a_pipeline_post");
  if (!isSocialSimulationEnabled()) throw new ScpRouteError(409, SOCIAL_SIMULATION_REFUSAL.disabled);

  // 4. Under the post's lock: judge again from the rows, and move each queued variant's time up to now. One transaction, so a
  //    concurrent unschedule (which resets the variants) and this cannot interleave.
  const nowMs = Date.now();
  const moved = await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId, true);
    if (!row || row.deleted_at !== null) throw new ScpRouteError(404, "post_not_found");
    const variants = await loadVariants(c, tenantId, postId);
    const decided = await decidedVariantIds(c, tenantId, variants.map((v) => v.id));
    const j = judgeSimulatedPublish({ pipelineStatus: row.pipeline_status, scheduleVia: row.schedule_via, variants, decided });
    if (!j.ok) throw new ScpRouteError(409, j.code, j.detail ? { detail: j.detail } : {});
    const ids: string[] = [];
    let advanced = 0;
    for (const v of variants) {
      if (v.status !== "queued" || !v.provider_post_id) continue;
      const next = advanceSimulatedPostId(v.provider_post_id, nowMs);
      // An id the simulator did not mint is not this route's to touch (the accounts are simulated, so this is a data fault).
      if (next === null) throw new ScpRouteError(409, SOCIAL_SIMULATION_REFUSAL.accountNotSimulated, { detail: { variantId: v.id } });
      if (next !== v.provider_post_id) {
        const upd = await c.query(
          `UPDATE social_post_variants SET provider_post_id = $3, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND provider_post_id = $4`,
          [tenantId, v.id, next, v.provider_post_id],
        );
        if ((upd.rowCount ?? 0) > 0) advanced += 1;
      }
      ids.push(next);
    }
    return { ids, advanced };
  }, SOCIAL);

  // 5. After the commit: the status read for each moved-or-due variant, through the status sweep's own on-ramp. Each applies
  //    `published` (or `failed`) idempotently and settles the post; the last one makes it live. A final settle with no
  //    variants named covers a post whose variants were already all published.
  for (const id of moved.ids) await reconcileOneProviderPost(tenantId, id);
  await settlePublisherResults(tenantId);
  const after = await withTenants([tenantId], async (c) => (await loadPostRow(c, tenantId, postId))?.pipeline_status ?? null, SOCIAL);

  await writeActivity(tenantId, principal.userId, "simulated_publish_now", "social_post", postId, {
    advanced: moved.advanced, live: after === "live", simulated: true, viaPortal: false,
  });
  return { postId, advanced: moved.advanced, live: after === "live" };
}
