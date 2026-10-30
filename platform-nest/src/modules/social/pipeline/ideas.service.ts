// SCP-5 W5-B2 — "Ideas for next month": the orchestration behind the routes (FRONTEND-BFF-CONTRACT §63.25.2, §63.25.3). One shape for every write:
//
//   1. 404: the idea (or the client) from the rows. An id that does not exist is answered 404 only AFTER the caller passed the gate on a
//      would-be post with no officer (so a caller who cannot write ideas at all reads 403 for a known and an unknown id alike, and an id's
//      existence is never a free probe).
//   2. 403: the gate, `authorizeIdeaWrite`: the client's would-be post, built from the rows, asked as creating a pipeline post is: the
//      machine's own `create` gate (`decide` in `gate` mode: unattended automation, then Cerbos `create` plus `author` or `approve`).
//      The resource's officer is the idea's engagement's, never the body's.
//   3. 400: the body, against the company's ideas settings (A0's `socialRules`).
//   4. 409: the idea's state, read under its row lock (`FOR UPDATE`), so two clicks decide one after the other.
//
// "ADD TO NEXT PLAN" is ONE transaction: the idea locked, the post made by the machine's `create` (`createPostInTx`, exactly as the sheet import
// makes its posts: `extra` columns, the content month's progress synced), the idea made `planned` with its cycle, post and planner. A refusal of
// the create, or any failure after the post's INSERT, rolls both back: the idea is as it was and no post exists. The activity rows come after
// the commit, as every pipeline write writes them.
//
// THE MODULE WALL. Every query on a `social_*` table runs inside `withTenants(..., { modules: ["social"] })`.
import { ForbiddenException, Logger } from "@nestjs/common";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import type { Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds } from "../pipeline-authz";
import { todayIsoInTz } from "./cycles-data";
import {
  cycleIsClosed, monthOfDay, parseIdeaCreate, parseIdeaFilter, parseIdeaPatch, parsePlanBody, planPostFields, isUuid,
  type IdeaAnswer,
} from "./ideas";
import {
  insertIdea, isMonthlyReportOf, loadIdea, loadIdeaAnyState, markIdeaPlanned, markIdeaShared, readIdea, readIdeas, softDeleteIdea, updateIdeaText,
} from "./ideas-data";
import { cerbosActionsToAsk, decide, type CerbosDecisions, type StageRefusal } from "./machine";
import {
  assertSessionCurrent, authorizeStage, cerbosDecisionsFor, createPostInTx, isAutomationPrincipal,
} from "./pipeline.service";
import { loadCycle, loadEngagement, loadPostRow, type EngagementRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import { ideasSettings, socialRules } from "./rules";

const SOCIAL = { modules: ["social"] };
const log = new Logger("SocialIdeas");

/** What a write that passed the gate carries on: the caller, and the would-be post's resource and Cerbos answers (the plan route's create reuses them). */
interface Gate { callerId: string; resource: Resource; cerbos: CerbosDecisions; isOfficer: boolean }

/** The client's would-be post, from the rows (63.25.2): `ownerId` the engagement's officer ("" when none or unknown), `approverIds` the two seats. */
async function wouldBePost(tenantId: string, ownerId: string): Promise<Resource> {
  const approverIds = await withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), SOCIAL);
  return { kind: "social_post", tenantId, module: "social", ownerId, creatorId: "", approverIds, assigneeIds: [], creativeSource: "" };
}

/**
 * The gate (63.25.2): `create` plus `author` or `approve` on the would-be post, through the machine's own `create` gate, so the codes are the
 * pipeline's: 403 `automation_cannot_act` for an unattended automation, 403 `not_officer_or_approver` for a holder of `create` who is neither
 * the officer nor one of the four, the generic 403 for one who holds no `create`. A refusal is audited as every denial is. Throws; or returns the gate.
 */
async function authorizeIdeaWrite(principal: Principal, tenantId: string, ownerId: string): Promise<Gate> {
  const callerId = principal.userId ?? null;
  const resource = await wouldBePost(tenantId, ownerId);
  const cerbos = await cerbosDecisionsFor(principal, resource, cerbosActionsToAsk("create", null));
  const isOfficer = !!callerId && ownerId !== "" && ownerId === callerId;
  const gate = decide({
    action: "create", params: { title: "idea" }, cerbos, post: null, facts: {}, mode: "gate",
    principal: { userId: callerId ?? undefined, isAutomation: isAutomationPrincipal(principal), isAuthor: false, isOfficer },
  });
  if (!gate.ok) return authorizeStage(principal, resource, "create", gate);
  await assertSessionCurrent(principal);
  if (!callerId) throw new ForbiddenException("not authorized: an authenticated user is required");
  return { callerId, resource, cerbos, isOfficer };
}

const notFound = (code: "idea_not_found" | "engagement_not_found" | "cycle_not_found"): ScpRouteError => new ScpRouteError(404, code);

/** The engagement of an idea or a route, read in the company's scope: null when it is not this company's. */
async function engagementOf(tenantId: string, engagementId: string): Promise<EngagementRow | null> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadEngagement(c, tenantId, engagementId);
  }, SOCIAL);
}

/** 404 for an id that is not there, after the gate on a would-be post with no officer (step 1 of the header). */
async function refuseUnknown(principal: Principal, tenantId: string, code: "idea_not_found" | "engagement_not_found"): Promise<never> {
  await authorizeIdeaWrite(principal, tenantId, "");
  throw notFound(code);
}

/** The idea and its engagement, or the 404 above. */
async function ideaAndEngagement(principal: Principal, tenantId: string, ideaId: string) {
  const pre = isUuid(ideaId)
    ? await withTenants([tenantId], async (c) => {
      const idea = await loadIdea(c, tenantId, ideaId);
      return { idea, engagement: idea ? await loadEngagement(c, tenantId, idea.engagement_id) : null };
    }, SOCIAL)
    : { idea: null, engagement: null };
  if (!pre.idea || !pre.engagement) return refuseUnknown(principal, tenantId, "idea_not_found");
  return { idea: pre.idea, engagement: pre.engagement };
}

const activity = (tenantId: string, actorId: string, verb: string, ideaId: string, metadata: Record<string, unknown>): Promise<void> =>
  writeActivity(tenantId, actorId, verb, "social_idea", ideaId, metadata).then(() => undefined)
    .catch((e: unknown) => log.warn(`activity ${verb} for idea ${ideaId} not written: ${e instanceof Error ? e.message : String(e)}`));

// ═══ GET engagements/:engagementId/ideas ═══════════════════════════════════════════════════════════════════════════════════

export async function listIdeas(
  principal: Principal, tenantId: string, engagementId: string, q: { status?: unknown; reportId?: unknown },
): Promise<{ items: IdeaAnswer[]; canWrite: boolean }> {
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  const engagement = isUuid(engagementId) ? await engagementOf(tenantId, engagementId) : null;
  if (!engagement) throw notFound("engagement_not_found");
  const filter = parseIdeaFilter(q);
  const items = await withTenants([tenantId], (c) => readIdeas(c, tenantId, engagement.id, filter), SOCIAL);
  // `canWrite` (the UI's): the gate's own question, answered without throwing.
  const ownerId = engagement.owner_id ?? "";
  const resource = await wouldBePost(tenantId, ownerId);
  const cerbos = await cerbosDecisionsFor(principal, resource, cerbosActionsToAsk("create", null));
  const callerId = principal.userId ?? "";
  const gate = decide({
    action: "create", params: { title: "idea" }, cerbos, post: null, facts: {}, mode: "gate",
    principal: { userId: callerId || undefined, isAutomation: isAutomationPrincipal(principal), isAuthor: false, isOfficer: callerId !== "" && callerId === ownerId },
  });
  return { items, canWrite: gate.ok && callerId !== "" };
}

// ═══ POST engagements/:engagementId/ideas ══════════════════════════════════════════════════════════════════════════════════

export async function createIdea(principal: Principal, tenantId: string, engagementId: string, body: unknown): Promise<{ idea: IdeaAnswer; created: boolean }> {
  const engagement = isUuid(engagementId) ? await engagementOf(tenantId, engagementId) : null;
  if (!engagement) return refuseUnknown(principal, tenantId, "engagement_not_found");
  const gate = await authorizeIdeaWrite(principal, tenantId, engagement.owner_id ?? "");

  const out = await withTenants([tenantId], async (c) => {
    const input = parseIdeaCreate(body, ideasSettings((await socialRules(c, tenantId)).rules));
    if (input.reportId && !(await isMonthlyReportOf(c, tenantId, engagement.id, input.reportId))) throw new ScpRouteError(400, "invalid_field", { field: "reportId" });
    // A replayed `id` answers `created: false`; an `id` taken by another client (or a deleted idea) is 400 `{field: 'id'}`.
    const taken = input.id ? await loadIdeaAnyState(c, tenantId, input.id) : null;
    if (taken) {
      if (taken.engagement_id !== engagement.id || taken.deleted_at !== null) throw new ScpRouteError(400, "invalid_field", { field: "id" });
      return { id: taken.id, created: false };
    }
    const id = input.id ?? newId();
    const created = await insertIdea(c, { tenantId, id, engagementId: engagement.id, saw: input.saw, metric: input.metric, suggestion: input.suggestion, reportId: input.reportId, actorId: gate.callerId });
    if (!created) {
      // A racing replay won the INSERT: the same rule over the row it wrote.
      const won = await loadIdeaAnyState(c, tenantId, id);
      if (!won || won.engagement_id !== engagement.id || won.deleted_at !== null) throw new ScpRouteError(400, "invalid_field", { field: "id" });
    }
    return { id, created };
  }, SOCIAL);

  if (out.created) await activity(tenantId, gate.callerId, "created", out.id, { engagementId: engagement.id });
  return { idea: await readOne(tenantId, out.id), created: out.created };
}

async function readOne(tenantId: string, ideaId: string): Promise<IdeaAnswer> {
  const idea = await withTenants([tenantId], (c) => readIdea(c, tenantId, ideaId), SOCIAL);
  if (!idea) throw notFound("idea_not_found");
  return idea;
}

// ═══ PATCH ideas/:ideaId ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export async function editIdea(principal: Principal, tenantId: string, ideaId: string, body: unknown): Promise<{ idea: IdeaAnswer }> {
  const { idea: seen, engagement } = await ideaAndEngagement(principal, tenantId, ideaId);
  const gate = await authorizeIdeaWrite(principal, tenantId, engagement.owner_id ?? "");
  const fields = await withTenants([tenantId], async (c) => {
    const patch = parseIdeaPatch(body, ideasSettings((await socialRules(c, tenantId)).rules));
    const row = await loadIdea(c, tenantId, seen.id, true);
    if (!row) throw notFound("idea_not_found");
    if (row.status === "planned") throw new ScpRouteError(409, "idea_planned");
    await updateIdeaText(c, tenantId, row.id, patch);
    return Object.keys(patch);
  }, SOCIAL);
  await activity(tenantId, gate.callerId, "updated", seen.id, { engagementId: engagement.id, fields });
  return { idea: await readOne(tenantId, seen.id) };
}

// ═══ POST ideas/:ideaId/share ══════════════════════════════════════════════════════════════════════════════════════════════════

export async function shareIdea(principal: Principal, tenantId: string, ideaId: string): Promise<{ idea: IdeaAnswer; alreadyApplied: boolean }> {
  const { idea: seen, engagement } = await ideaAndEngagement(principal, tenantId, ideaId);
  const gate = await authorizeIdeaWrite(principal, tenantId, engagement.owner_id ?? "");
  const shared = await withTenants([tenantId], async (c) => {
    const row = await loadIdea(c, tenantId, seen.id, true);
    if (!row) throw notFound("idea_not_found");
    if (row.status === "planned") throw new ScpRouteError(409, "idea_planned");
    if (row.status === "shared") return false;
    await markIdeaShared(c, tenantId, row.id, gate.callerId);
    return true;
  }, SOCIAL);
  if (shared) await activity(tenantId, gate.callerId, "shared", seen.id, { engagementId: engagement.id });
  return { idea: await readOne(tenantId, seen.id), alreadyApplied: !shared };
}

// ═══ DELETE ideas/:ideaId ══════════════════════════════════════════════════════════════════════════════════════════════════════

export async function deleteIdea(principal: Principal, tenantId: string, ideaId: string): Promise<{ deleted: true; id: string }> {
  const { idea: seen, engagement } = await ideaAndEngagement(principal, tenantId, ideaId);
  const gate = await authorizeIdeaWrite(principal, tenantId, engagement.owner_id ?? "");
  await withTenants([tenantId], async (c) => {
    const row = await loadIdea(c, tenantId, seen.id, true);
    if (!row) throw notFound("idea_not_found");
    if (row.status === "planned") throw new ScpRouteError(409, "idea_planned");
    await softDeleteIdea(c, tenantId, row.id, gate.callerId);
  }, SOCIAL);
  await activity(tenantId, gate.callerId, "deleted", seen.id, { engagementId: engagement.id });
  return { deleted: true, id: seen.id };
}

// ═══ POST ideas/:ideaId/plan  ("Add to next plan") ═══════════════════════════════════════════════════════════════════════════

export interface PlanAnswer {
  alreadyApplied: boolean;
  idea: IdeaAnswer;
  post: { id: string; title: string; cycleId: string; cycleMonth: string };
}

/** What the plan's transaction answers: the new post, a replay, or the machine's refusal of the create (nothing was written). */
type PlanTx =
  | { kind: "planned"; postId: string; title: string; cycleMonth: string; cycleId: string }
  | { kind: "replay"; postId: string; title: string; cycleMonth: string; cycleId: string }
  | { kind: "refused"; refusal: StageRefusal };

export async function planIdea(principal: Principal, tenantId: string, ideaId: string, body: unknown): Promise<PlanAnswer> {
  // 404 idea_not_found, then 403 on the idea's client.
  const { idea: seen, engagement } = await ideaAndEngagement(principal, tenantId, ideaId);
  const gate = await authorizeIdeaWrite(principal, tenantId, engagement.owner_id ?? "");

  // 400 `{field: 'cycleId'}`; 404 `cycle_not_found` (another client's cycle included); 409 `cycle_closed` (its month is before the report month).
  const { cycleId } = parsePlanBody(body);
  const cycle = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadCycle(c, tenantId, cycleId);
  }, SOCIAL);
  if (!cycle || cycle.engagement_id !== engagement.id) throw notFound("cycle_not_found");
  if (cycleIsClosed(cycle.month, monthOfDay(todayIsoInTz(config.reportsTz)))) throw new ScpRouteError(409, "cycle_closed");

  // ONE transaction. The idea is locked FIRST, so a second click waits here and then reads what the first one wrote.
  const result: PlanTx = await withTenants([tenantId], async (c): Promise<PlanTx> => {
    const idea = await loadIdea(c, tenantId, seen.id, true);
    if (!idea) throw notFound("idea_not_found");
    if (idea.status === "planned") {
      // A replay: 200 with its post when that post is live (not discarded) in the cycle asked for, else 409.
      const post = idea.post_id ? await loadPostRow(c, tenantId, idea.post_id) : null;
      if (post && post.deleted_at === null && idea.cycle_id === cycle.id) {
        return { kind: "replay", postId: post.id, title: post.title, cycleMonth: cycle.month, cycleId: cycle.id };
      }
      throw new ScpRouteError(409, "idea_planned");
    }
    const f = planPostFields(idea);
    const base = {
      action: "create", params: { title: f.title }, cerbos: gate.cerbos,
      principal: { userId: gate.callerId, isAutomation: isAutomationPrincipal(principal), isAuthor: false, isOfficer: gate.isOfficer },
    };
    const r = await createPostInTx(c, {
      tenantId, cycleId: cycle.id, callerId: gate.callerId, base,
      // The post's own columns beyond the machine's `create`: the client's allocated platforms, the angle, and the idea it came from.
      extra: { angle: f.angle, placement: engagement.platforms, idea_id: idea.id },
    });
    if ("refusal" in r) return { kind: "refused", refusal: r.refusal }; // nothing was written; the idea's lock ends with the transaction
    if (!r.created) throw new ScpRouteError(409, "idea_planned"); // cannot happen (a fresh id); never link an idea to a post this call did not make
    // Anything that throws from here on rolls the post back with it.
    await markIdeaPlanned(c, { tenantId, ideaId: idea.id, cycleId: cycle.id, postId: r.id, actorId: gate.callerId });
    return { kind: "planned", postId: r.id, title: f.title, cycleMonth: cycle.month, cycleId: cycle.id };
  }, SOCIAL);

  if (result.kind === "refused") return authorizeStage(principal, gate.resource, "create", result.refusal);

  const ideaAnswer = await readOne(tenantId, seen.id);
  if (result.kind === "planned") {
    // After the commit: the post's `create` row carries the idea (63.25.3); the idea's own `planned` row.
    await writeActivity(tenantId, gate.callerId, "create", "social_post", result.postId, {
      from: null, to: "planned", cycleId: result.cycleId, engagementId: engagement.id, viaPortal: false, ideaId: seen.id,
    }).catch((e: unknown) => log.warn(`activity create for post ${result.postId} not written: ${e instanceof Error ? e.message : String(e)}`));
    await activity(tenantId, gate.callerId, "planned", seen.id, { engagementId: engagement.id, postId: result.postId, cycleId: result.cycleId });
  }
  return {
    alreadyApplied: result.kind === "replay",
    idea: ideaAnswer,
    post: { id: result.postId, title: result.title, cycleId: result.cycleId, cycleMonth: result.cycleMonth },
  };
}
