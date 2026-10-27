// SCP-1b — the stage machine behind the routes (FRONTEND-BFF-CONTRACT §63.3, §63.6). One orchestration for every write:
//
//   1. Read what Cerbos must see from the rows (the post, `loadSocialPostAuthz`), never from a body.
//   2. Ask Cerbos once for the actions the machine names (`cerbosActionsToAsk`), the delegated person too when the call
//      acts for someone (`authorize()`'s intersection).
//   3. `decide()` in `gate` mode: steps 1 to 11 of §63.3.2 (the body included), with no row locked. A refusal at the
//      automation, maker/checker or Cerbos step is audited exactly as `authorize()` audits a denial (`authorizeStage`),
//      then answered 403 with its code: authorization before validation, so a refused caller never reads a 400 or a 409.
//   4. ONE transaction: the post locked `FOR UPDATE`, the facts read under the lock, `decide()` again in full (steps 8 and
//      9 re-checked inside it, then the action's own guards), the row written with the machine's `set`, the copy log, and
//      every I/O effect (`pipeline-effects.ts`).
//   5. After the commit: the activity row (`writeActivity`, which stamps `via` when an agent drove the call) and the
//      notifications (`notify()`, never to the actor; a failure never undoes the action).
import { ForbiddenException, HttpException, UnauthorizedException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { authorize, notify, writeActivity, explainDenial } from "../../../core/http";
import { buildPipelinePost, readCerbosActions } from "./pipeline-read";
import { syncContentMonthProgress } from "./content-month-progress";
import { notifyApprovalFiled } from "../../../core/approval-filing";
import { notifyBestEffort, resolveClientRecipients } from "../../../core/client-notify";
import { memoiseSessionCurrent } from "../../../core/request-context";
import { loadAuthFacts, notifyRequestReceived } from "../../../core/work-requests.service";
import { deniedOnlyForAssurance } from "../../../auth/step-up";
import { checkActions, type Resource } from "../../../rbac/cerbos";
import { assemblePrincipal, auditDecision, sessionVersionCurrent, type Principal } from "../../../rbac/principal";
import { isModuleEnabled } from "../../registry";
import { loadSocialApproverIds, loadSocialPostAuthz, socialPostResource, type SocialPostAuthz } from "../pipeline-authz";
import { scpAction } from "./fixture";
import {
  cerbosActionsToAsk, cerbosChecksFor, changeCaseOf, decide, holderOf, primaryCerbosAction,
  type CerbosDecisions, type PipelinePostState, type StageApplied, type StageRefusal,
} from "./machine";
import {
  findDepartmentBySlug, holderUserIds, loadCycle, loadEngagement, loadFacts, loadPostRow, roleHolders, stateOf,
  type CycleRow, type EngagementRow,
} from "./pipeline-data";
import {
  EFFECT_RUNNERS, ScpRouteError, cancelQueuedDispatchesBeforeTx, emptyOutput, insertCopyLog, insertPostRow, isNotification,
  updatePostRow, type EffectOutput,
} from "./pipeline-effects";

const SOCIAL = { modules: ["social"] };

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Cerbos and the audit
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The Cerbos answers for `actions` on one resource, as `authorize()` would reach them: the caller, and (a delegated call)
 *  the person it acts for as well; either denial denies. Advisory reads only; the audit happens in `authorizeStage`. */
export async function cerbosDecisionsFor(principal: Principal, resource: Resource, actions: string[]): Promise<CerbosDecisions> {
  if (!actions.length) return {};
  const mine = await checkActions(principal, resource, actions);
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const theirs = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    const other = theirs ? await checkActions({ ...theirs, via: principal.via }, resource, actions) : {};
    for (const a of actions) mine[a] = mine[a] === true && other[a] === true;
  }
  return mine;
}

/** The refusal steps that are authorization: audited like `authorize()`'s denials. */
const AUTHZ_GUARDS = new Set(["not_unattended_automation", "maker_checker", "cerbos"]);

/**
 * `authorizeStage()`: the one helper that answers a refused stage action. An authorization refusal is audited exactly as
 * `authorize()` audits a denial (`auditDecision`, the denied action and the reason), carries `reason: "assurance_required"`
 * where only the assurance tier stands in the way (PV5-14), and answers 403 with the machine's code (or, for create's
 * `create`, today's generic `not authorized: …`). Any other refusal is its HTTP error.
 */
export async function authorizeStage(principal: Principal, resource: Resource, actionName: string, r: StageRefusal): Promise<never> {
  if (AUTHZ_GUARDS.has(r.guard)) {
    const a = scpAction(actionName);
    const denied = deniedCerbosAction(actionName, a ? primaryCerbosAction(a, null) : actionName, r);
    const reason = explainDenial(principal, `${r.code}: cerbos denied ${denied} on ${resource.kind}`);
    await auditDecision(resource.tenantId ?? null, principal, denied, resource.kind, resource.id ?? null, false, reason);
    const assurance = await deniedOnlyForAssurance(principal, resource, denied).catch(() => false);
    if (r.generic) {
      throw new ForbiddenException(assurance
        ? { message: `not authorized: cerbos denied ${denied} on ${resource.kind} (this action needs a second factor)`, reason: "assurance_required" }
        : `not authorized: cerbos denied ${denied} on ${resource.kind}`);
    }
    throw new HttpException({ message: r.code, ...(assurance ? { reason: "assurance_required" } : {}) }, 403);
  }
  throw httpOf(r);
}

function deniedCerbosAction(actionName: string, fallback: string, r: StageRefusal): string {
  if (r.guard !== "cerbos") return fallback;
  const a = scpAction(actionName);
  if (!a) return fallback;
  // The check whose refusal this is (create's anyOf answers not_officer_or_approver; reschedule's cancel cancel_required).
  const hit = cerbosChecksFor(a, null).concat(cerbosChecksFor(a, { scheduleVia: "publisher" } as PipelinePostState)).find((c) => c.refusal.code === r.code);
  return hit ? hit.actions.join("|") : fallback;
}

/** A refusal as its HTTP error: `{error, field?, detail?, blockers?, retryAfterSeconds?}` (BFF §63.0). */
export function httpOf(r: StageRefusal): HttpException {
  return new ScpRouteError(r.http, r.code, {
    ...(r.field ? { field: r.field } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.blockers ? { blockers: r.blockers } : {}),
    ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
  });
}

/** D11 (`authorize()`'s last step): a revoked session is 401 on every action. */
async function assertSessionCurrent(principal: Principal): Promise<void> {
  if (principal.userId && !(await memoiseSessionCurrent(principal.userId, principal.sessionVersion, () => sessionVersionCurrent(principal)))) {
    throw new UnauthorizedException("session revoked — re-authenticate");
  }
}

const isAutomationPrincipal = (p: Principal) => p.kind === "automation" || p.kind === "bot";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// One stage action on one post
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface StageRequest {
  tenantId: string;
  postId: string;
  action: string;
  params: Record<string, unknown>;
  expectedStatus?: string;
  actionId?: string;
  requireExpectedStatus?: boolean;
}

export interface StageOutcome {
  postId: string;
  applied: StageApplied;
  out: EffectOutput;
}

interface Prepared {
  pre: { row: Awaited<ReturnType<typeof loadPostRow>>; authz: SocialPostAuthz | null };
  state: PipelinePostState | null;
  resource: Resource;
  cerbos: CerbosDecisions;
  principalFacts: (authz: SocialPostAuthz | null) => { userId?: string; isAutomation: boolean; isAuthor: boolean; isOfficer: boolean };
  base: { action: string; params: Record<string, unknown>; cerbos: CerbosDecisions; expectedStatus?: string; actionId?: string; requireExpectedStatus?: boolean };
  /** The gate's answer when it was a replay (`alreadyApplied`); null when the action goes on to the transaction. */
  replay: StageApplied | null;
  callerId: string;
}

/** Steps 1 to 3 of the orchestration (the header): the rows, Cerbos once, and the gate. Throws the refusal. */
async function prepareStage(principal: Principal, req: StageRequest): Promise<Prepared> {
  const { tenantId, postId, action } = req;
  const callerId = principal.userId ?? null;

  // 1. The rows Cerbos must see.
  const pre = await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId);
    const authz = row && row.deleted_at === null ? await loadSocialPostAuthz(c, tenantId, postId) : null;
    return { row, authz };
  }, SOCIAL);
  const state = stateOf(pre.row);
  const resource: Resource = pre.authz ? socialPostResource(tenantId, pre.authz) : { kind: "social_post", tenantId, module: "social" };

  // 2. Cerbos, once.
  const asked = state && state.pipelineStatus !== null ? cerbosActionsToAsk(action, state) : [];
  const cerbos = await cerbosDecisionsFor(principal, resource, asked);
  const principalFacts = (authz: SocialPostAuthz | null) => ({
    userId: callerId ?? undefined,
    isAutomation: isAutomationPrincipal(principal),
    isAuthor: !!callerId && !!authz?.creatorId && authz.creatorId === callerId,
    isOfficer: !!callerId && !!authz?.ownerId && authz.ownerId === callerId,
  });

  // 3. The gate: steps 1 to 11, nothing locked.
  const base = {
    action, params: req.params, cerbos, expectedStatus: req.expectedStatus, actionId: req.actionId,
    requireExpectedStatus: req.requireExpectedStatus,
  };
  const gate = decide({ ...base, post: state, principal: principalFacts(pre.authz), facts: {}, mode: "gate" });
  if (!gate.ok) return authorizeStage(principal, resource, action, gate);
  if (!gate.alreadyApplied) await assertSessionCurrent(principal);
  if (!callerId) throw new ForbiddenException("not authorized: an authenticated user is required");
  return { pre, state, resource, cerbos, principalFacts, base, replay: gate.alreadyApplied ? gate : null, callerId };
}

/** Whether the cycle's month request is still open (the post would join it, not open a new one: `joinOrOpenMonthRequest`). */
async function cycleHasOpenMonthRequest(tenantId: string, cycleId: string | null): Promise<boolean> {
  if (!cycleId) return false;
  const r = await withTenants([tenantId], (c) => c.query(
    `SELECT 1 FROM social_cycles sc JOIN work_requests w ON w.id = sc.creative_request_id
      WHERE sc.tenant_id = $1 AND sc.id = $2 AND w.status = 'open' LIMIT 1`, [tenantId, cycleId]), SOCIAL);
  return (r.rowCount ?? 0) > 0;
}

/** Run one action on one existing post, start to finish. Throws the HTTP error of a refusal. */
export async function runStageAction(principal: Principal, req: StageRequest): Promise<StageOutcome> {
  const { tenantId, postId, action } = req;
  const { pre, state, resource, cerbos, principalFacts, base, replay, callerId } = await prepareStage(principal, req);
  if (replay) return { postId, applied: replay, out: emptyOutput() };

  // BFF §63.3.5: approving a `creatives` client's post for design may open the cycle's month request, which also needs
  // `work_request` · `create` for the acting approver (any member holds it). Judged with the other authorization, before
  // the lock, and audited by `authorize()` itself.
  if (action === "approve_for_design" && pre.row) {
    const src = await withTenants([tenantId], (c) => c.query<{ creative_source: string }>(
      `SELECT creative_source FROM social_engagements WHERE tenant_id = $1 AND id = $2`, [tenantId, pre.row!.engagement_id]), SOCIAL);
    if (src.rows[0]?.creative_source === "creatives") {
      await authorize(principal, { kind: "work_request", tenantId }, "create");
      // An asset request needs the company's PM module (its task is the designers' work in Creatives' own board), exactly as
      // `POST requests` checks it (409 `request_kind_unavailable`, §32.5). Joining a request that is already open needs no new
      // task, so only the opening of one is refused. A module check is a second connection, so it is made here, before the lock.
      if (!(await isModuleEnabled(tenantId, "pm")) && !(await cycleHasOpenMonthRequest(tenantId, pre.row.cycle_id))) {
        throw new ScpRouteError(409, "request_kind_unavailable");
      }
    }
  }

  // Network work before the lock: cancel a queued dispatch at the publisher (unschedule, reschedule).
  const cancelled = (action === "unschedule" || action === "reschedule") && state?.pipelineStatus === "scheduled"
    ? await cancelQueuedDispatchesBeforeTx(tenantId, postId)
    : new Set<string>();

  // 4. The transaction.
  const result = await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId, true);
    const locked = stateOf(row);
    if (!row || !locked) return { refusal: notFoundRefusal() };
    // The Cerbos actions this decision needs under the lock must be the ones asked (a publisher schedule that appeared
    // since names another action): otherwise the post changed under the caller.
    if (locked.pipelineStatus !== null && cerbosActionsToAsk(action, locked).some((a) => !(a in cerbos))) {
      return { refusal: statusChanged(locked) };
    }
    const engagement = await loadEngagement(c, tenantId, row.engagement_id);
    if (!engagement) return { refusal: notFoundRefusal() };
    const cycle = row.cycle_id ? await loadCycle(c, tenantId, row.cycle_id) : null;
    const who = {
      ownerId: engagement.owner_id ?? "",
      approverIds: pre.authz?.approverIds ?? (await loadSocialApproverIds(c, tenantId)),
      assigneeIds: pre.authz?.assigneeIds ?? [],
    };
    const facts = await loadFacts(c, { tenantId, action, state: locked, params: req.params, engagement, cycle, callerId, who });
    const lockedAuthz = pre.authz ? { ...pre.authz, ownerId: who.ownerId, creatorId: locked.authorId ?? "" } : null;
    const r = decide({ ...base, post: locked, principal: principalFacts(lockedAuthz), facts, mode: "apply" });
    if (!r.ok) return { refusal: r };
    if (r.alreadyApplied) return { applied: r, out: emptyOutput(), engagement, cycle, before: locked };

    await updatePostRow(c, tenantId, postId, r.set, r.appendSkippedChecks);
    await insertCopyLog({ c, tenantId, postId, actorId: callerId }, r.copyLog);
    const out = emptyOutput(cancelled);
    out.warnings.push(...r.warnings);
    const run = { c, tenantId, actorId: callerId, action, postId, before: locked, next: r.next ?? locked, row, engagement, cycle, params: req.params, result: r, out };
    for (const name of r.effects) {
      if (isNotification(name)) continue;
      await EFFECT_RUNNERS[name](run);
    }
    return { applied: r, out, engagement, cycle, before: locked };
  }, SOCIAL);

  if ("refusal" in result && result.refusal) return authorizeStage(principal, resource, action, result.refusal);
  const ok = result as { applied: StageApplied; out: EffectOutput; engagement: EngagementRow; cycle: CycleRow | null; before: PipelinePostState };
  if (!ok.applied.alreadyApplied) {
    await afterCommit(principal, tenantId, postId, ok.applied, ok.out, ok.engagement, ok.cycle, ok.before, pre.authz);
  }
  return { postId, applied: ok.applied, out: ok.out };
}

function notFoundRefusal(): StageRefusal {
  return { ok: false, http: 404, code: "post_not_found", guard: "post_exists" };
}

function statusChanged(state: PipelinePostState): StageRefusal {
  return { ok: false, http: 409, code: "status_changed", guard: "expected_status_matches", detail: { status: state.pipelineStatus } };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Create (BFF §63.6.1)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export async function createPipelinePost(principal: Principal, tenantId: string, cycleId: string, params: Record<string, unknown>): Promise<{ postId: string; created: boolean }> {
  const callerId = principal.userId ?? null;
  const pre = await withTenants([tenantId], async (c) => {
    const cycle = await loadCycle(c, tenantId, cycleId);
    const engagement = cycle ? await loadEngagement(c, tenantId, cycle.engagement_id) : null;
    const approverIds = await loadSocialApproverIds(c, tenantId);
    const existing = typeof params.id === "string" ? await loadPostRow(c, tenantId, params.id) : null;
    return { cycle, engagement, approverIds, existing };
  }, SOCIAL);
  // The would-be post: the cycle's officer and the four, read from the rows (BFF §63.6.1, PERMISSION §53.2).
  const resource: Resource = {
    kind: "social_post", tenantId, module: "social", ownerId: pre.engagement?.owner_id ?? "", creatorId: "",
    approverIds: pre.approverIds, assigneeIds: [], creativeSource: "",
  };
  const cerbos = await cerbosDecisionsFor(principal, resource, cerbosActionsToAsk("create", null));
  const principalFacts = { userId: callerId ?? undefined, isAutomation: isAutomationPrincipal(principal), isAuthor: false, isOfficer: !!callerId && pre.engagement?.owner_id === callerId };
  // A replayed `id` answers 201 `created: false` (BFF §63.0): the existing row stands in as the post.
  const existing = pre.existing && pre.existing.deleted_at === null && pre.existing.cycle_id === cycleId ? stateOf(pre.existing) : null;
  const base = { action: "create", params, cerbos, principal: principalFacts };
  const gate = decide({ ...base, post: existing, facts: {}, mode: "gate" });
  if (!gate.ok) return authorizeStage(principal, resource, "create", gate);
  if (gate.alreadyApplied) return { postId: existing!.id, created: false };
  await assertSessionCurrent(principal);
  if (!callerId) throw new ForbiddenException("not authorized: an authenticated user is required");
  if (pre.existing && !existing) throw new ScpRouteError(400, "invalid_field", { field: "id" }); // an id taken elsewhere

  const out = await withTenants([tenantId], async (c) => {
    const cycle = await loadCycle(c, tenantId, cycleId, true);
    const engagement = cycle ? await loadEngagement(c, tenantId, cycle.engagement_id) : null;
    const facts = { now: new Date(), cycleExists: cycle !== null && engagement !== null, cycleId: cycle?.id, engagementId: engagement?.id };
    const r = decide({ ...base, post: null, facts, mode: "apply" });
    if (!r.ok) return { refusal: r };
    const ins = await insertPostRow(c, tenantId, engagement!.id, callerId, r.set);
    // A new counted post that is not approved yet reopens a done content-month task (SCP-1n, BFF §63.13).
    if (ins.created) await syncContentMonthProgress(c, tenantId, cycle!.id, callerId);
    return { applied: r, ...ins, engagement: engagement!, cycle: cycle! };
  }, SOCIAL);
  if ("refusal" in out && out.refusal) return authorizeStage(principal, resource, "create", out.refusal);
  const ok = out as { applied: StageApplied; id: string; created: boolean; engagement: EngagementRow; cycle: CycleRow };
  if (ok.created) {
    await writeActivity(tenantId, callerId, "create", "social_post", ok.id, {
      from: null, to: ok.applied.to, cycleId: ok.cycle.id, engagementId: ok.engagement.id, viaPortal: false,
    });
  }
  return { postId: ok.id, created: ok.created };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The read (BFF §63.6.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** `GET posts/:postId/pipeline`: `social_post` · `read`, or, when read is refused, `design` on the same post (one Cerbos
 *  call for both and for the `actions[]` the page draws). 404 `post_not_found`, 409 `not_a_pipeline_post`. */
export async function readPipelinePost(principal: Principal, tenantId: string, postId: string): Promise<Record<string, unknown>> {
  const pre = await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId);
    const authz = row && row.deleted_at === null ? await loadSocialPostAuthz(c, tenantId, postId) : null;
    return { row, authz };
  }, SOCIAL);
  if (!pre.row || pre.row.deleted_at !== null || !pre.authz) throw new ScpRouteError(404, "post_not_found");
  const resource = socialPostResource(tenantId, pre.authz);
  const state = stateOf(pre.row)!;
  const needed = ["read", "design", ...(state.pipelineStatus !== null ? readCerbosActions(state) : [])];
  const cerbos = await cerbosDecisionsFor(principal, resource, [...new Set(needed)]);
  if (!cerbos.read && !cerbos.design) await authorize(principal, resource, "read"); // audits the denial and throws 403
  await assertSessionCurrent(principal);
  if (state.pipelineStatus === null) throw new ScpRouteError(409, "not_a_pipeline_post");
  const authz = pre.authz;
  return withTenants([tenantId], (c) => buildPipelinePost({
    c, tenantId, row: pre.row!, principal, resource, cerbos,
    who: { ownerId: authz.ownerId, approverIds: authz.approverIds, assigneeIds: authz.assigneeIds },
  }), SOCIAL);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PATCH posts/:postId/designs/:designId (BFF §63.6.6)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const LINK_SOURCES = ["own", "client", "stock", "ai", "unknown"];

/**
 * `{position?, linkSource?, linkAiNote?}` on one design. The route has no fixture action of its own; it consults
 * `remove_design`'s row, which is the same actor (`design`), the same statuses and the same `designId` (§63.3.1: the
 * designs routes "each consult the same fixture row"). The body is judged after authorization, as everywhere.
 */
export async function patchDesign(principal: Principal, tenantId: string, postId: string, designId: string, body: Record<string, unknown>): Promise<void> {
  const expectedStatus = typeof body.expectedStatus === "string" ? body.expectedStatus : undefined;
  const { callerId } = await prepareStage(principal, {
    tenantId, postId, action: "remove_design", params: { designId }, expectedStatus, requireExpectedStatus: false,
  });
  const keys = ["position", "linkSource", "linkAiNote"].filter((k) => body[k] !== undefined);
  if (!keys.length) throw new ScpRouteError(400, "missing_field", { field: "position" });
  if (body.position !== undefined && !(Number.isInteger(body.position) && (body.position as number) >= 1 && (body.position as number) <= 20)) {
    throw new ScpRouteError(400, "invalid_field", { field: "position" });
  }
  if (body.linkSource !== undefined && !(typeof body.linkSource === "string" && LINK_SOURCES.includes(body.linkSource))) {
    throw new ScpRouteError(400, "invalid_field", { field: "linkSource" });
  }
  if (body.linkAiNote !== undefined && body.linkAiNote !== null && !(typeof body.linkAiNote === "string" && [...body.linkAiNote].length <= 1000)) {
    throw new ScpRouteError(400, "invalid_field", { field: "linkAiNote" });
  }
  await withTenants([tenantId], async (c) => {
    const row = await loadPostRow(c, tenantId, postId, true);
    if (!row) throw new ScpRouteError(404, "post_not_found");
    const d = await c.query<{ id: string; link_url: string | null; link_source: string | null; link_ai_note: string | null }>(
      `SELECT id, link_url, link_source, link_ai_note FROM social_post_designs
        WHERE tenant_id = $1 AND post_id = $2 AND id = $3 AND removed_at IS NULL FOR UPDATE`,
      [tenantId, postId, designId],
    );
    const design = d.rows[0];
    if (!design) throw new ScpRouteError(404, "design_not_found");
    // A link's source and note only: an asset's are set where the asset is saved (BFF §63.6.6).
    if ((body.linkSource !== undefined || body.linkAiNote !== undefined) && !design.link_url) {
      throw new ScpRouteError(400, "invalid_field", { field: body.linkSource !== undefined ? "linkSource" : "linkAiNote" });
    }
    const source = (body.linkSource as string | undefined) ?? design.link_source;
    const note = body.linkAiNote !== undefined ? (body.linkAiNote as string | null) : design.link_ai_note;
    if (design.link_url && source === "ai" && !(typeof note === "string" && note.trim())) throw new ScpRouteError(400, "missing_field", { field: "linkAiNote" });
    if (body.position !== undefined) {
      const taken = await c.query(
        `SELECT 1 FROM social_post_designs WHERE tenant_id = $1 AND post_id = $2 AND position = $3 AND id <> $4 AND removed_at IS NULL`,
        [tenantId, postId, body.position, designId],
      );
      if (taken.rowCount) throw new ScpRouteError(400, "invalid_field", { field: "position" });
    }
    await c.query(
      `UPDATE social_post_designs SET position = COALESCE($4, position), link_source = $5, link_ai_note = $6
        WHERE tenant_id = $1 AND post_id = $2 AND id = $3`,
      [tenantId, postId, designId, body.position ?? null, design.link_url ? source : null, design.link_url ? note : null],
    );
  }, SOCIAL);
  await writeActivity(tenantId, callerId, "update_design", "social_post", postId, { designId, fields: keys });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// After the commit: activity and notifications (BFF §63.14)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

async function afterCommit(
  principal: Principal, tenantId: string, postId: string, r: StageApplied, out: EffectOutput,
  engagement: EngagementRow, cycle: CycleRow | null, before: PipelinePostState, authz: SocialPostAuthz | null,
): Promise<void> {
  const actorId = principal.userId ?? null;
  const holderBefore = before.pipelineStatus ? holderOf(before) : null;
  await writeActivity(tenantId, actorId, r.action, "social_post", postId, {
    ...r.activity.metadata,
    cycleId: cycle?.id ?? null,
    engagementId: engagement.id,
    viaPortal: false,
    ...(r.action === "follow_up" ? { holder: holderBefore } : {}),
  });
  for (const a of out.filedApprovals) await notifyApprovalFiled(a.id, a.input);
  if (out.openedRequest) {
    await writeActivity(tenantId, actorId, "created", "work_request", out.openedRequest.id, { kind: "assets", toUnitId: out.openedRequest.toUnitId, socialPostId: postId });
    // The helper made the receiving unit's intake project, so it writes the activity `POST requests` writes for it (§32.5).
    if (out.openedRequest.intake.created) {
      await writeActivity(tenantId, actorId, "created", "project", out.openedRequest.intake.projectId, {
        name: `${out.openedRequest.toName} · Requests`, intakeFor: out.openedRequest.toUnitId,
      });
    }
    // The receiving unit's heads hear of the request as they do of a hand-filed one (§32.7 `request.received`). A request opened
    // just now has no assignees, so the "designers" notification below reaches nobody for it. Best-effort, like every notification.
    if (actorId) await notifyRequestReceived(tenantId, actorId, out.openedRequest.id, out.openedRequest.toUnitId, out.openedRequest.toName, out.openedRequest.title);
  }
  try {
    await sendNotifications(tenantId, actorId, postId, r, out, engagement, before, authz);
  } catch (err) {
    // A notification never undoes the action (BFF §63.14).
    // eslint-disable-next-line no-console
    console.error(`[scp] notifications for ${r.action} on ${postId} failed:`, (err as Error)?.message ?? err);
  }
}

const TITLES: Record<string, string> = {
  "social.post.your_turn": "A post is waiting for you",
  "social.post.client_changed": "The client asked for a change",
  "social.post.client_decided": "The client's decision was recorded",
  "social.post.follow_up": "A follow-up on a post",
};

async function sendNotifications(
  tenantId: string, actorId: string | null, postId: string, r: StageApplied, out: EffectOutput,
  engagement: EngagementRow, before: PipelinePostState, authz: SocialPostAuthz | null,
): Promise<void> {
  const names = r.effects.filter(isNotification);
  if (!names.length) return;
  const dept = await withTenants([tenantId], (c) => findDepartmentBySlug(c, tenantId, "social-media"));
  const approverIds = authz?.approverIds ?? [];
  const next = r.next ?? before;
  const payload = (type: string) => ({
    title: TITLES[type] ?? "Post update",
    ...(dept ? { href: `/departments/${dept.id}/posts/${postId}` } : {}),
    entityType: "social_post", entityId: postId, severity: "info" as const, action: r.action,
  });
  const send = async (ids: string[], type: string) => {
    for (const id of new Set(ids)) await notify(tenantId, id, actorId, type, payload(type));
  };
  const recorded = r.action === "record_client_approve" || r.action === "record_client_change";
  const designers = async (): Promise<string[]> => {
    if (next.creativeSource === "in_team") return roleHolders(tenantId, "social_designer");
    const requestId = out.joinedRequestId ?? (await withTenants([tenantId], (c) => c.query<{ id: string | null }>(
      `SELECT creative_request_id::text AS id FROM social_posts WHERE tenant_id = $1 AND id = $2`, [tenantId, postId]), SOCIAL)).rows[0]?.id;
    if (!requestId) return [];
    return (await withTenants([tenantId], (c) => loadAuthFacts(c, tenantId, requestId)))?.assigneeIds ?? [];
  };

  for (const name of names) {
    const who = name.slice(name.indexOf(":") + 1);
    if (name.startsWith("notify_after_undo_window:")) continue; // SCP-2: the portal decision's undo window
    switch (who) {
      case "copywriters": await send(await roleHolders(tenantId, "social_copywriter"), "social.post.your_turn"); break;
      case "approvers": await send(approverIds, "social.post.your_turn"); break;
      case "approvers_told": await send(approverIds, "social.post.client_changed"); break;
      case "designers": await send(await designers(), "social.post.your_turn"); break;
      case "officer": await send(engagement.owner_id ? [engagement.owner_id] : [], recorded ? "social.post.client_decided" : "social.post.your_turn"); break;
      case "holder": {
        // resolve: the new holder is told it is their turn; follow_up: the current holder is reminded.
        const state = r.action === "follow_up" ? before : next;
        const type = r.action === "follow_up" ? "social.post.follow_up" : "social.post.your_turn";
        if (state.pipelineStatus && holderOf(state) === "client") {
          const recipients = await withTenants([tenantId], (c) => resolveClientRecipients(c, { clientId: engagement.client_id, projectId: engagement.project_id, kind: "general" }));
          await notifyBestEffort(tenantId, actorId, recipients, type, payload(type));
        } else {
          const h = await holderUserIds(tenantId, state, { ownerId: engagement.owner_id ?? "", approverIds, assigneeIds: authz?.assigneeIds ?? [] });
          await send(h.userIds, type);
        }
        break;
      }
      // The client is told once per post by the review request's own event, inside the transaction (requestReviews).
      case "client": case "client_once_per_post": break;
      // ⚠ CONTRACT GAP: §63.14 has no type for telling the client that staff recorded their decision.
      case "client_recorded": break;
      case "officer_when_by_publisher": break; // SCP-3b: the publisher's result path
      default:
        // eslint-disable-next-line no-console
        console.warn(`[scp] unknown notification '${name}' on ${r.action}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// systemRules.change_after_client (BFF §63.3.5): a Composer edit after the client approved
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Inside the transaction of `PATCH variants/:variantId` or `POST variants/:variantId/media/attach` (whose variant write has
 * just moved its args hash): when the variant's post is an `approved` or `scheduled` pipeline post, send the post back to
 * the client. A scheduled post is unscheduled first (its undecided publish approvals withdrawn, its variants back to
 * draft), every variant's review is requested again, `schedule_via` is cleared, and the client is told once. A variant
 * of the post that is queued or mid-publish refuses the edit (409 `dispatch_in_flight`): the dispatch must be cancelled
 * through `unschedule` first. Answers the post id when it moved, for the caller's activity row.
 */
export async function changeAfterClientInTx(c: PoolClient, tenantId: string, postId: string, actorId: string | null): Promise<string | null> {
  const row = await loadPostRow(c, tenantId, postId, true);
  if (!row || row.deleted_at !== null || row.archived_at !== null) return null;
  if (row.pipeline_status !== "approved" && row.pipeline_status !== "scheduled") return null;
  const engagement = await loadEngagement(c, tenantId, row.engagement_id);
  if (!engagement) return null;
  const busy = await c.query(
    `SELECT 1 FROM social_post_variants WHERE tenant_id = $1 AND post_id = $2 AND deleted_at IS NULL AND status IN ('queued','publishing') LIMIT 1`,
    [tenantId, postId],
  );
  if (busy.rowCount) throw new ScpRouteError(409, "dispatch_in_flight");
  const state = stateOf(row)!;
  const out = emptyOutput();
  // The effects the fixture's rule names, run through the same runners the actions use.
  const fake: StageApplied = {
    ok: true, alreadyApplied: false, action: "change_after_client", from: row.pipeline_status, to: "client",
    changeCase: { before: changeCaseOf(state), after: null }, phase: "with_client", engineStatus: "in_review",
    set: {}, appendSkippedChecks: null, copyLog: [], effects: ["notify:client_once_per_post"], columnEffects: [],
    activity: { verb: "changed_after_client", metadata: {} }, warnings: [], next: { ...state, pipelineStatus: "client", scheduleVia: null },
  };
  const run = { c, tenantId, actorId: actorId ?? "", action: "change_after_client", postId, before: state, next: fake.next!, row, engagement, cycle: null, params: {}, result: fake, out };
  if (row.pipeline_status === "scheduled") await EFFECT_RUNNERS.cancel_queued_dispatches_and_withdraw_pending_approvals(run);
  await EFFECT_RUNNERS.request_client_reviews_on_every_variant(run);
  await c.query(
    `UPDATE social_posts SET pipeline_status = 'client', status = 'in_review', status_since = now(), schedule_via = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, postId],
  );
  // The post went back to the client: the cycle's content-month task reopens (SCP-1n, BFF §63.13), now that the row says so.
  await EFFECT_RUNNERS.content_month_progress(run);
  return postId;
}

/** The activity row of a change after the client (after the caller's commit). */
export async function recordChangeAfterClient(tenantId: string, actorId: string | null, postId: string, variantId: string): Promise<void> {
  await writeActivity(tenantId, actorId, "changed_after_client", "social_post", postId, { from: null, to: "client", variantId, viaPortal: false });
}
