// SCP-2 — the client's decisions on a pipeline post, in the portal (FRONTEND-BFF-CONTRACT §63.9): `client_approve`,
// `client_change` and `client_undo` of the fixture, plus "approve all".
//
// The same orchestration every staff action uses (pipeline.service.ts), with the portal's order of checks:
//   1. Cerbos `portal` · `approve_post` on `{kind: "portal", tenantId}` (`authorize()`: audited, and the session check),
//   2. `resolvePortalScope` (the caller's clients; 403 for someone who is no contact),
//   3. visibility (`portal-read.ts`): a post that is not a pipeline post of one of the caller's clients, or not yet sent to the
//      client, or deleted or archived, is 404 `post_not_found`, never 403 (no existence oracle),
//   4. the machine: `decide()` on the portal surface (a visible post outside the action's `from` is 409 `post_not_with_client`),
//      in ONE transaction with the post locked FOR UPDATE (`applyStageInTx`, the very function the staff routes run, with the one
//      optional `hook` SCP-2 added to it), every variant review decided together, or none.
// Only the `decision` field is judged before the lock. The note, the pin and the rest of the body are judged under it, after the
// visibility, the replay and the post's status, so a post that is not waiting answers 409 and a decision already made answers
// `alreadyDecided`, never a 400 about a body that no longer matters (§63.9).
// The client is never the post's author or its officer, so the principal facts are false; the machine takes the Cerbos answer
// for `portal:approve_post` as given (step 1), and its own refusal for a denial (404) is therefore never the one a client sees.
//
// IDEMPOTENCY. The same decision replayed answers 200 `alreadyDecided`; a different decision after one was made is 409
// `client_review_already_decided`. The replay is detected under the lock, from the reviews themselves (a decided review carries
// its `decision_id`), before the machine runs, because the post has already left `client`.
//
// UNDO. A decision stamps the post's `last_action_id` with its own id (the portal runner passes the decision id as the action's
// id), and every later action overwrites it: that is how "nothing happened since" is known without comparing two clocks.
// `restore_pre_decision_fields` puts back what the decision changed: the change fields, `changed_only` and `copy_before`
// (cleared: a decision is only ever taken from a post that has them cleared) and, after a design change, `creative_state`
// `submitted` (loadFacts documents why that is the value every post at `client` has).
import { ForbiddenException, HttpException } from "@nestjs/common";
import { withTenants, newId } from "../../../db";
import { authorize } from "../../../core/http";
import { resolvePortalScope, type PortalScope } from "../../../core/portal-scope";
import type { Principal } from "../../../rbac/principal";
import type { Resource } from "../../../rbac/cerbos";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialPostAuthz, type SocialPostAuthz } from "../pipeline-authz";
import { scpAction } from "./fixture";
import { fromMatches, type StageApplied, type StageRefusal } from "./machine";
import { loadPostRow, loadEngagement, stateOf, type PostRow } from "./pipeline-data";
import { ScpRouteError, type EffectOutput } from "./pipeline-effects";
import {
  afterCommit, applyStageInTx, authorizeStage, notFoundRefusal, type Prepared, type StageBase, type StageRequest, type StageTxResult,
} from "./pipeline.service";
import { portalPostVisibleSql, portalStateOf, postVisibleTo, type PortalState } from "./portal-read";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORTAL_CERBOS = { "portal:approve_post": true } as const;

export interface PortalDecision {
  decisionId: string;
  postId: string;
  state: PortalState;
  undoUntil: string | null;
  alreadyDecided?: true;
}

export interface PortalUndo {
  decisionId: string;
  postId: string;
  state: PortalState;
}

const portalResource = (tenantId: string): Resource => ({ kind: "portal", tenantId });
const bad = (field: string, code: "missing_field" | "invalid_field" = "invalid_field") => new ScpRouteError(400, code, { field });

/** The only part of the body judged before the lock: `decision` picks the machine's action (400 `{field: "decision"}`). The rest
 *  (the hash, the change kind, the note, the pin) is passed on as it came and judged under the lock (`judgeBody`, then the machine). */
function parseDecision(body: unknown): { action: "client_approve" | "client_change"; params: Record<string, unknown> } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.decision === undefined || b.decision === null || b.decision === "") throw bad("decision", "missing_field");
  if (b.decision !== "approve" && b.decision !== "change") throw bad("decision");
  const params: Record<string, unknown> = {};
  for (const k of ["seenHash", "changeKind", "note", "anchor"]) if (b[k] !== undefined && b[k] !== null) params[k] = b[k];
  return { action: b.decision === "approve" ? "client_approve" : "client_change", params };
}

const refusal400 = (field: string): StageTxResult => ({ refusal: { ok: false, http: 400, code: "invalid_field", field, guard: "params_valid" } });

/** The body checks the database or the post's state decides, under the lock and only for a post that is waiting (any other is the
 *  machine's 409 or a replay): an approval's optional note (1 to 2,000), and a pin `{x, y, fileId}` (x and y in [0, 1], `fileId`
 *  a live design file of the post), of which only those three keys are kept. The change's own fields are the machine's. */
async function judgeBody(
  c: import("pg").PoolClient, tenantId: string, postId: string, action: string, params: Record<string, unknown>,
): Promise<StageTxResult | null> {
  if (action === "client_approve") {
    if (params.note !== undefined && (typeof params.note !== "string" || params.note.trim().length === 0 || [...params.note.trim()].length > 2000)) {
      return refusal400("note");
    }
    delete params.anchor;
    return null;
  }
  if (params.anchor === undefined) return null;
  const a = params.anchor as Record<string, unknown> | null;
  const frac = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!a || typeof a !== "object" || Array.isArray(a) || !frac(a.x) || !frac(a.y) || !(await pinFile(c, tenantId, postId, a.fileId))) {
    return refusal400("anchor");
  }
  params.anchor = { x: a.x, y: a.y, fileId: a.fileId };
  return null;
}

/** The resource every portal refusal is audited against. */
async function refused(principal: Principal, tenantId: string, action: string, r: StageRefusal): Promise<never> {
  return authorizeStage(principal, portalResource(tenantId), action, r);
}

interface Seen {
  scope: PortalScope;
  row: PostRow;
  clientId: string;
  authz: SocialPostAuthz | null;
}

/** Steps 2 and 3, outside the lock: the caller's scope, and the post if it is visible to them (else 404). */
async function seePost(principal: Principal, tenantId: string, postId: string): Promise<Seen> {
  const seen = await withTenants([tenantId], async (c) => {
    const scope = await resolvePortalScope(c, principal);
    await declareSocialModuleScope(c);
    const row = await loadPostRow(c, tenantId, postId);
    const eng = row ? await loadEngagement(c, tenantId, row.engagement_id) : null;
    if (!row || !eng || !postVisibleTo(row, eng.client_id, scope.clientIds)) return null;
    return { scope, row, clientId: eng.client_id, authz: await loadSocialPostAuthz(c, tenantId, postId) };
  }, SOCIAL);
  if (!seen) throw new ScpRouteError(404, "post_not_found");
  return seen;
}

/** Whether `fileId` is a live design file of the post (the pin of a change request sits on one of them). */
async function pinFile(c: import("pg").PoolClient, tenantId: string, postId: string, fileId: unknown): Promise<boolean> {
  if (typeof fileId !== "string" || !UUID_RE.test(fileId)) return false;
  const r = await c.query(
    `SELECT 1 FROM social_post_designs WHERE tenant_id = $1 AND post_id = $2 AND file_id = $3::uuid AND removed_at IS NULL`,
    [tenantId, postId, fileId],
  );
  return r.rows.length > 0;
}

/** The decision a post carries now, if every live variant's review has been decided together under one decision id. */
async function currentDecision(c: import("pg").PoolClient, tenantId: string, postId: string): Promise<
  { decisionId: string; status: "approved" | "changes_requested"; changeKind: string | null; undoUntil: string | null } | null
> {
  const r = await c.query<{ status: string; decision_id: string | null; change_kind: string | null; undo_live: boolean; undo_until: Date | null }>(
    `SELECT r.status, r.decision_id::text AS decision_id, r.change_kind, (r.undo_until IS NOT NULL AND r.undo_until > clock_timestamp()) AS undo_live, r.undo_until
       FROM social_post_variants v
       JOIN social_post_client_reviews r ON r.variant_id = v.id AND r.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.post_id = $2 AND v.deleted_at IS NULL`,
    [tenantId, postId],
  );
  const rows = r.rows;
  if (!rows.length || rows.some((x) => !x.decision_id || (x.status !== "approved" && x.status !== "changes_requested"))) return null;
  const first = rows[0];
  if (rows.some((x) => x.decision_id !== first.decision_id || x.status !== first.status)) return null;
  const live = first.undo_live && first.undo_until;
  return {
    decisionId: first.decision_id!, status: first.status as "approved" | "changes_requested", changeKind: first.change_kind,
    undoUntil: live ? new Date(first.undo_until as Date).toISOString() : null,
  };
}

interface DecisionOutcome { decision: PortalDecision }

const portalPrincipalFacts = (principal: Principal) => () => ({
  userId: principal.userId as string, isAutomation: principal.kind === "automation" || principal.kind === "bot", isAuthor: false, isOfficer: false,
});

/** What `prepareStage` is for the staff routes, for the portal's order of checks: the rows read, Cerbos already answered (step 1),
 *  nothing to gate yet. The machine's own gate runs inside the lock (`applyStageInTx`). */
function preparedFor(principal: Principal, tenantId: string, seen: Pick<Seen, "row" | "authz">, base: StageBase): Prepared {
  return {
    pre: { row: seen.row, authz: seen.authz }, state: stateOf(seen.row), resource: portalResource(tenantId),
    cerbos: { ...PORTAL_CERBOS }, principalFacts: portalPrincipalFacts(principal), base, replay: null, callerId: principal.userId as string,
  };
}

/**
 * One decision on one post, after authorization (the caller has already asked Cerbos and resolved nothing else). Used by the
 * decide route and, once per listed post, by approve-all.
 */
async function decideOne(principal: Principal, tenantId: string, postId: string, body: unknown): Promise<DecisionOutcome> {
  const seen = await seePost(principal, tenantId, postId);
  const { action, params: given } = parseDecision(body);
  const decisionId = newId();
  const params: Record<string, unknown> = { ...given, decisionId };
  const base: StageBase = { action, params, cerbos: { ...PORTAL_CERBOS }, actionId: decisionId, requireExpectedStatus: false, surface: "portal" };
  const req: StageRequest = { tenantId, postId, action, params, actionId: decisionId, requireExpectedStatus: false };
  const wantStatus = action === "client_approve" ? "approved" : "changes_requested";
  let replay: PortalDecision | null = null;

  const result = await withTenants([tenantId], (c) => applyStageInTx(c, preparedFor(principal, tenantId, seen, base), req, new Set<string>(),
    async ({ c: tx, row, state, engagement }): Promise<StageTxResult | null> => {
      // Visibility again, under the lock: the post may have been archived or deleted since the caller saw it.
      if (!postVisibleTo(row, engagement.client_id, seen.scope.clientIds)) return { refusal: notFoundRefusal() };
      // A replay or a different decision after one was made: the reviews carry the decision.
      const current = await currentDecision(tx, tenantId, postId);
      if (current) {
        const same = current.status === wantStatus && (action === "client_approve" || current.changeKind === params.changeKind);
        if (!same) return { refusal: { ok: false, http: 409, code: "client_review_already_decided", guard: "every_variant_review_pending" } };
        replay = { decisionId: current.decisionId, postId, state: portalStateOf(state.pipelineStatus), undoUntil: current.undoUntil, alreadyDecided: true };
        // Not a refusal of the client's: an answer. Nothing was written, and the caller reads `replay` first.
        return { refusal: { ok: false, http: 200, code: "already_decided", guard: "replay" } };
      }
      // The body's own checks, only for a post that is waiting: any other status is the machine's 409 `post_not_with_client`.
      if (!fromMatches(scpAction(action)!, state)) return null;
      return judgeBody(tx, tenantId, postId, action, params);
    }), SOCIAL);

  if (replay) return { decision: replay };
  if ("refusal" in result && result.refusal) return refused(principal, tenantId, action, result.refusal);
  const ok = result as Extract<StageTxResult, { applied: StageApplied }>;
  await afterCommit(principal, tenantId, postId, ok.applied, ok.out, ok.engagement, ok.cycle, ok.before, seen.authz, { viaPortal: true });
  return { decision: { decisionId: ok.out.decisionId ?? decisionId, postId, state: portalStateOf(ok.applied.to), undoUntil: ok.out.undoUntil } };
}

/** `POST portal/social/posts/:postId/decide` (BFF §63.9). */
export async function portalDecide(principal: Principal, tenantId: string, postId: string, body: unknown): Promise<PortalDecision> {
  await authorize(principal, portalResource(tenantId), "approve_post");
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");
  return (await decideOne(principal, tenantId, postId, body)).decision;
}

export interface ApproveAllResult {
  results: Array<{ postId: string; outcome: "approved" | "skipped"; reason?: string; decisionId?: string }>;
  undoUntil: string | null;
}

/** Refusal codes an approve-all item reports as a skip. Anything else (a 500, a lost connection) is not a skip and propagates. */
const SKIPPABLE = new Set(["post_not_found", "post_not_with_client", "content_changed", "client_review_already_decided", "invalid_field", "missing_field"]);

/**
 * `POST portal/social/posts/approve-all` (BFF §63.9): approves exactly the listed posts that still wait with an unchanged hash,
 * each in its own transaction. A post that no longer waits, whose content changed, that is not the caller's or that was already
 * decided is skipped with its reason, and never fails the others.
 */
export async function portalApproveAll(principal: Principal, tenantId: string, body: unknown): Promise<ApproveAllResult> {
  await authorize(principal, portalResource(tenantId), "approve_post");
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");
  // Authorization first, validation second: the list is read only now.
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const items = b.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw bad("items", items === undefined ? "missing_field" : "invalid_field");
  for (const it of items) {
    const o = it as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.postId !== "string" || typeof o.seenHash !== "string" || !o.seenHash) throw bad("items");
  }
  const results: ApproveAllResult["results"] = [];
  let undoUntil: string | null = null;
  for (const it of items as Array<{ postId: string; seenHash: string }>) {
    try {
      const { decision } = await decideOne(principal, tenantId, it.postId, { decision: "approve", seenHash: it.seenHash });
      if (decision.alreadyDecided) {
        results.push({ postId: it.postId, outcome: "skipped", reason: "client_review_already_decided", decisionId: decision.decisionId });
        continue;
      }
      results.push({ postId: it.postId, outcome: "approved", decisionId: decision.decisionId });
      if (decision.undoUntil && (!undoUntil || decision.undoUntil > undoUntil)) undoUntil = decision.undoUntil;
    } catch (err) {
      const code = err instanceof HttpException ? ((err.getResponse() as { message?: string } | string)) : null;
      const reason = typeof code === "string" ? code : code?.message;
      if (err instanceof HttpException && reason && SKIPPABLE.has(reason)) {
        results.push({ postId: it.postId, outcome: "skipped", reason });
        continue;
      }
      throw err;
    }
  }
  return { results, undoUntil };
}

/** `POST portal/social/decisions/:decisionId/undo` (BFF §63.9): only the contact who decided, inside the window, with nothing
 *  happened to the post since. 404 `decision_not_found` for a decision outside the caller's scope. */
export async function portalUndo(principal: Principal, tenantId: string, decisionId: string): Promise<PortalUndo> {
  await authorize(principal, portalResource(tenantId), "approve_post");
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");
  const notFound = () => new ScpRouteError(404, "decision_not_found");
  if (!UUID_RE.test(decisionId)) throw notFound();

  // The post the decision sits on, if that post is visible to the caller (a decision of another client's is not found).
  const found = await withTenants([tenantId], async (c) => {
    const scope = await resolvePortalScope(c, principal);
    await declareSocialModuleScope(c);
    const r = await c.query<{ post_id: string }>(
      `SELECT DISTINCT p.id::text AS post_id
         FROM social_post_client_reviews r
         JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
         JOIN social_posts p ON p.tenant_id = v.tenant_id AND p.id = v.post_id
         JOIN social_engagements e ON e.tenant_id = p.tenant_id AND e.id = p.engagement_id
        WHERE r.tenant_id = $1 AND r.decision_id = $2::uuid AND ${portalPostVisibleSql("p", "e", 3)}`,
      [tenantId, decisionId, scope.clientIds],
    );
    const postId = r.rows[0]?.post_id;
    const row = postId ? await loadPostRow(c, tenantId, postId) : null;
    return postId && row ? { scope, postId, row, authz: await loadSocialPostAuthz(c, tenantId, postId) } : null;
  }, SOCIAL);
  if (!found) throw notFound();
  const { postId, scope } = found;

  const params = { decisionId };
  const base: StageBase = { action: "client_undo", params, cerbos: { ...PORTAL_CERBOS }, requireExpectedStatus: false, surface: "portal" };
  const req: StageRequest = { tenantId, postId, action: "client_undo", params, requireExpectedStatus: false };
  const result = await withTenants([tenantId], (c) => applyStageInTx(c, preparedFor(principal, tenantId, found, base), req, new Set<string>(),
    async ({ c: tx, row, state, engagement }): Promise<StageTxResult | null> => {
      const gone: StageTxResult = { refusal: { ok: false, http: 404, code: "decision_not_found", guard: "post_exists" } };
      if (!postVisibleTo(row, engagement.client_id, scope.clientIds)) return gone;
      // Under the lock, the decision must still be on the reviews. Two undos at once: the second finds it gone (404, not 409); and a
      // change after the client that reset the reviews inside the window set the decision aside, so it reads as gone too.
      const carried = await tx.query(
        `SELECT 1 FROM social_post_client_reviews r JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND v.post_id = $2 AND v.deleted_at IS NULL AND r.decision_id = $3::uuid LIMIT 1`,
        [tenantId, postId, decisionId]);
      if (!carried.rows.length) return gone;
      // A decision whose post has moved on (scheduled, live, handed back to the team) cannot be taken back: the window is over.
      // The machine would call this "post_not_with_client"; the contract's word for it is the window (BFF §63.9).
      if (!fromMatches(scpAction("client_undo")!, state)) return { refusal: { ok: false, http: 409, code: "undo_window_passed", guard: "nothing_happened_since" } };
      return null;
    }), SOCIAL);

  if ("refusal" in result && result.refusal) {
    // The post vanished under the lock: for this route that is the decision that is gone.
    const r = result.refusal.code === "post_not_found" ? { ...result.refusal, code: "decision_not_found" } : result.refusal;
    return refused(principal, tenantId, "client_undo", r);
  }
  const ok = result as Extract<StageTxResult, { applied: StageApplied }>;
  const out: EffectOutput = ok.out;
  await afterCommit(principal, tenantId, postId, ok.applied, out, ok.engagement, ok.cycle, ok.before, found.authz, { viaPortal: true });
  return { decisionId, postId, state: portalStateOf(ok.applied.to) };
}
