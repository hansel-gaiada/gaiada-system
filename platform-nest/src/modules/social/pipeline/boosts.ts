// SCP-4a — boosts and the monthly boost budget, staff side: the request, the boost's transitions, the budget's proposals, withdrawals and
// recordings, and the notices (BFF §63.11; fixture `boosts` and `boostBudgets`; plan rulings SCP-Q11, SCP-Q15, SCP-Q18, SCP-Q19). The money
// rules and the cycle lock are boosts-data.ts's; the portal's decisions are portal-spend.ts's; the routes are boosts.controller.ts's.
//
// NO ADS ARE BOUGHT BY THE ERP (§63.11). Nothing here spends money, buys an ad or calls any network: the rows RECORD what the team runs in
// Meta's own tools, or what the simulator runs. `start_boost` and `complete_boost` move a row; they reach no ad platform.
//
// WHO (PERMISSION §53.1, §53.6; the fixture's `cerbosActions`), asked on the REAL resources built from the rows, never from a body:
//   social_post · boost          the client's officer, the HoD or GM seat (and platform_admin); the owner runs NO boost.   403 not_officer_or_approver
//   social_engagement · budget   the four approvers: the HoD and GM seats, the owner, the superadmin.                      403 not_a_social_approver
//   social_post · read           every read (the team's read tier).
// An unattended automation (`users.kind` automation or bot) is refused every write 403 `automation_cannot_act` (§63.15) before Cerbos is
// asked (Cerbos denies it too). An agent acting for a person arrives as that person; `writeActivity` stamps `via`.
//
// ORDER OF ANSWERS on every write: 404 (`post_not_found`, `boost_not_found`, `cycle_not_found`, `proposal_not_found`; another company's id is
// absent here) → 403 (automation, then the Cerbos decision with its code) → 400 `{field}` (the body) → 409 in the fixture's guard order.
// A refused caller therefore never reads a 400 or a 409. On `POST boosts/:boostId/actions` the action names the gate, so it is read before
// the decision; an absent or unknown action is answered 400 only to a caller who holds `boost` or `budget` (anyone else gets 403).
//
// MONEY UNDER CONCURRENCY. Every write runs in ONE transaction that takes the cycle lock (`lockBoostCycle`) FIRST, then reads committed and
// the agreement, then locks its own row `FOR UPDATE` and judges `expectedStatus`. The partial uniques are the backstop: a second open boost
// on a post (`ux_social_boosts_open_post`, possible across two months' cycles) is answered 409 `open_boost_exists`, a second pending proposal
// 409 `proposal_pending`.
//
// IDEMPOTENCY (§63.0). A request takes a caller-chosen `id` (uuid): the same id on the same post answers 201 `{…, created: false}` with the
// boost as it stands; an id already used for another post is 400 `{field: "id"}`. An action takes `expectedStatus` (required) and `actionId`
// (optional uuid): the same `actionId` as an action already applied to the boost answers 200 `{alreadyApplied: true}`. The boost table has no
// last-action column, so "already applied" is read from the action's own activity row (metadata `actionId`), written after the commit.
//
// ACTIVITY AND NOTICES, after the commit (`writeActivity`, `notify`; never to the actor; a failed notice never undoes the write):
//   boosts   entity `social_post`, verb the fixture's action, metadata {boostId, cycleId, engagementId, from, to, approvedVia?, channel?,
//            actionId?, viaPortal}. Never a note's text.
//   budgets  entity `social_engagement`, verb the fixture's action, metadata {cycleId, proposalId, channel?, viaPortal}.
//   social.boost.waiting_client, social.budget.proposed   the client's contacts with signing capability, href `/portal/approvals`;
//   social.boost.decided                                   the requester and the officer, href the post's staff page;
//   social.budget.recorded                                 the client's contacts (as `social.post.client_recorded`), href `/portal/approvals`.
//
// FOR THE SIMULATOR (SCP-Se, another session): `startBoost` and `completeBoost` below are the one entry point to start and complete a boost
// without a person (actor NULL), through the very transition the route runs (cycle lock, row lock, the fixture's `from`).
import { ForbiddenException, HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { authorize, notify, writeActivity } from "../../../core/http";
import { notifyBestEffort, resolveClientRecipients } from "../../../core/client-notify";
import { check, type Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";
import { loadSocialApproverIds, loadSocialPostAuthz, socialEngagementResource, socialPostResource, type SocialPostAuthz } from "../pipeline-authz";
import { SCP, type ScpSubMachineAction } from "./fixture";
import { findDepartmentBySlug, loadEngagement, userNames, type EngagementRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import {
  BOOST_AUDIENCES, BOOST_GOALS, BOOST_STATUSES, DEFAULT_CURRENCY, MAX_INT, MAX_MINOR, OPEN_BOOST_STATUSES, RECORD_CHANNELS,
  budgetCycleFor, cycleEngagement, estimateReach, fitsRemaining, loadBudget, loadCycleBudgets, loadRawBoost, lockBoostCycle, minorUnitOf,
  readBoostRow, readCycleMoney, type BoostRow, type BudgetRow, type CycleMoney, type RawBoost,
} from "./boosts-data";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The fixture's actions and where each is carried
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The actions `POST boosts/:boostId/actions` takes (§63.11). */
export const BOOST_ROUTE_ACTIONS = ["cancel_boost", "start_boost", "stop_boost", "complete_boost", "record_boost_approval", "record_boost_decline"] as const;
export type BoostRouteAction = (typeof BOOST_ROUTE_ACTIONS)[number];
/** The two of them that record the client's answer: `social_engagement` · `budget`, not `social_post` · `boost`. */
export const BOOST_RECORD_ACTIONS: ReadonlySet<string> = new Set(["record_boost_approval", "record_boost_decline"]);

/** Every action of the fixture's `boosts` and `boostBudgets`, and the route that carries it (pinned against the fixture by boosts.test.ts). */
export const BOOST_ACTION_ROUTES: Readonly<Record<string, string>> = {
  request_boost: "POST posts/:postId/boosts",
  approve_boost: "POST portal/social/spend/boosts/:boostId/decide {decision: 'approve'}",
  decline_boost: "POST portal/social/spend/boosts/:boostId/decide {decision: 'decline'}",
  record_boost_approval: "POST boosts/:boostId/actions",
  record_boost_decline: "POST boosts/:boostId/actions",
  cancel_boost: "POST boosts/:boostId/actions",
  start_boost: "POST boosts/:boostId/actions",
  stop_boost: "POST boosts/:boostId/actions",
  complete_boost: "POST boosts/:boostId/actions",
  propose_boost_budget: "POST cycles/:cycleId/boost-budget/proposals",
  agree_boost_budget: "POST portal/social/spend/budgets/:proposalId/decide {decision: 'agree'}",
  decline_boost_budget: "POST portal/social/spend/budgets/:proposalId/decide {decision: 'decline'}",
  record_boost_budget: "POST cycles/:cycleId/boost-budget/record",
  withdraw_boost_budget: "POST boost-budget/proposals/:proposalId/withdraw",
};

/** A fixture boost action by name (its `from` is the machine's word on which statuses it leaves). */
export function boostFixtureAction(name: string): ScpSubMachineAction | undefined {
  return SCP.boosts.actions.find((a) => a.action === name);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Authorization
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const isAutomationPrincipal = (p: Principal) => p.kind === "automation" || p.kind === "bot";

/**
 * A write's decision: 403 `automation_cannot_act` for an unattended automation, then `authorize()` (audited, the acting-for intersection,
 * the revoked-session check) with a plain DENIAL answered 403 `code` (an `assurance_required` reason, PV5-14, kept beside it). A 401 passes
 * through. Ends with a person: the writers stamp the caller's id.
 */
export async function authorizeCoded(principal: Principal, resource: Resource, action: string, code: string): Promise<string> {
  if (isAutomationPrincipal(principal)) throw new ScpRouteError(403, "automation_cannot_act");
  try {
    await authorize(principal, resource, action);
  } catch (e) {
    if (e instanceof ForbiddenException) {
      const res = e.getResponse() as { reason?: unknown };
      throw new HttpException({ message: code, ...(typeof res?.reason === "string" ? { reason: res.reason } : {}) }, 403);
    }
    throw e;
  }
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");
  return principal.userId;
}

/** `social_engagement` · `budget` on the engagement (the four approvers), or 403 `not_a_social_approver`. */
async function authorizeBudget(principal: Principal, tenantId: string, approverIds: string[], engagementId: string): Promise<string> {
  return authorizeCoded(principal, socialEngagementResource(tenantId, approverIds, engagementId), "budget", "not_a_social_approver");
}

/** Whether the caller may record money for the client (`canRecord`): a plain decision, never throwing on a denial; false for an automation. */
async function canRecordOf(principal: Principal, tenantId: string, approverIds: string[], engagementId: string): Promise<boolean> {
  if (isAutomationPrincipal(principal)) return false;
  return (await check(principal, socialEngagementResource(tenantId, approverIds, engagementId), "budget")).allow;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Body checks (after the decision)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const bad = (field: string, code: "missing_field" | "invalid_field" = "invalid_field") => new ScpRouteError(400, code, { field });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

function intField(b: Record<string, unknown>, field: string, min: number, max: number, required: boolean): number | null {
  const v = b[field];
  if (absent(v)) { if (required) throw bad(field, "missing_field"); return null; }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(field);
  return v;
}

function textField(b: Record<string, unknown>, field: string, max: number, required: boolean): string | null {
  const v = b[field];
  if (absent(v) || (typeof v === "string" && v.trim() === "")) { if (required) throw bad(field, "missing_field"); return null; }
  if (typeof v !== "string" || [...v.trim()].length > max) throw bad(field);
  return v.trim();
}

function enumField<T extends string>(b: Record<string, unknown>, field: string, values: readonly T[], required: boolean): T | null {
  const v = b[field];
  if (absent(v) || v === "") { if (required) throw bad(field, "missing_field"); return null; }
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw bad(field);
  return v as T;
}

/** A real calendar date `YYYY-MM-DD` (not 2026-02-31), between 2000 and 2100. */
export function isRealIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  if (y < 2000 || y > 2100) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface BoostRequestBody {
  id: string | null;
  goal: (typeof BOOST_GOALS)[number];
  audience: (typeof BOOST_AUDIENCES)[number];
  audienceNote: string | null;
  dailyBudgetMinor: number;
  days: number;
  startsOn: string;
  currency: string | null;
}

/** PURE. `POST posts/:postId/boosts`'s body (§63.11), or 400 `{field}`. The total (daily × days) may not exceed 10^12 (§63.0). */
export function parseBoostRequest(body: unknown): BoostRequestBody {
  const b = isObj(body) ? body : {};
  const id = b.id;
  if (!absent(id) && (typeof id !== "string" || !UUID_RE.test(id))) throw bad("id");
  const goal = enumField(b, "goal", BOOST_GOALS, true)!;
  const audience = enumField(b, "audience", BOOST_AUDIENCES, true)!;
  const audienceNote = textField(b, "audienceNote", 500, audience === "custom");
  const dailyBudgetMinor = intField(b, "dailyBudgetMinor", 1, MAX_MINOR, true)!;
  const days = intField(b, "days", 1, 90, true)!;
  if (dailyBudgetMinor * days > MAX_MINOR) throw bad("dailyBudgetMinor");
  if (absent(b.startsOn)) throw bad("startsOn", "missing_field");
  if (!isRealIsoDate(b.startsOn)) throw bad("startsOn");
  let currency: string | null = null;
  if (!absent(b.currency)) {
    if (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) throw bad("currency");
    currency = b.currency;
  }
  return { id: typeof id === "string" ? id.toLowerCase() : null, goal, audience, audienceNote, dailyBudgetMinor, days, startsOn: b.startsOn as string, currency };
}

export interface BoostTransitionParams {
  spendMinor?: number;
  paidReach?: number | null;
  clicks?: number | null;
  channel?: string;
  note?: string;
  reason?: string | null;
}

/** PURE. The action's own params (the fixture's `params`), or 400 `{field}`. */
export function parseTransitionParams(action: BoostRouteAction, b: Record<string, unknown>): BoostTransitionParams {
  switch (action) {
    case "stop_boost":
      return { spendMinor: intField(b, "spendMinor", 0, MAX_MINOR, true)!, paidReach: intField(b, "paidReach", 0, MAX_INT, false), clicks: intField(b, "clicks", 0, MAX_INT, false) };
    case "complete_boost":
      return { spendMinor: intField(b, "spendMinor", 0, MAX_MINOR, true)!, paidReach: intField(b, "paidReach", 0, MAX_INT, true)!, clicks: intField(b, "clicks", 0, MAX_INT, false) };
    case "record_boost_approval":
    case "record_boost_decline":
      return { channel: enumField(b, "channel", RECORD_CHANNELS, true)!, note: textField(b, "note", 2000, true)! };
    case "cancel_boost":
      return { reason: textField(b, "reason", 500, false) };
    case "start_boost":
      return {};
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Notices
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const TITLES: Record<string, string> = {
  "social.boost.waiting_client": "A boost is waiting for your approval",
  "social.budget.proposed": "A monthly boost budget is waiting for your approval",
  "social.boost.decided": "The client answered a boost",
  "social.budget.decided": "The client answered a monthly boost budget",
  "social.budget.recorded": "We recorded your monthly boost budget",
};

/** The Social Media department's page base, `/departments/<id>`, or null when the company has no such unit. */
async function socialDeptBase(tenantId: string): Promise<string | null> {
  const dept = await withTenants([tenantId], (c) => findDepartmentBySlug(c, tenantId, "social-media"));
  return dept ? `/departments/${dept.id}` : null;
}

/** The client's contacts: `signers` only (signer or admin, SCP-Q14) or every active one. Failures logged, never thrown. */
export async function notifyClientContacts(
  tenantId: string, actorId: string | null, clientId: string, projectId: string | null, signersOnly: boolean, type: string,
  extra: { entityType: string; entityId: string; action: string },
): Promise<void> {
  try {
    const recipients = await withTenants([tenantId], (c) => resolveClientRecipients(c, { clientId, projectId, kind: signersOnly ? "signature" : "general" }));
    await notifyBestEffort(tenantId, actorId, recipients, type, { title: TITLES[type], href: "/portal/approvals", severity: "info", ...extra });
  } catch (err) {
    console.error(`[scp-boosts] notice ${type} failed:`, (err as Error)?.message ?? err);
  }
}

/** `social.boost.decided` to the requester and the officer (never the actor), href the post's staff page. */
export async function notifyBoostDecided(tenantId: string, actorId: string | null, b: { postId: string; requestedBy: string }, officerId: string | null, action: string): Promise<void> {
  try {
    const base = await socialDeptBase(tenantId);
    const type = "social.boost.decided";
    for (const id of new Set([b.requestedBy, officerId].filter((x): x is string => !!x))) {
      await notify(tenantId, id, actorId, type, {
        title: TITLES[type], ...(base ? { href: `${base}/posts/${b.postId}` } : {}), entityType: "social_post", entityId: b.postId, severity: "info", action,
      }).catch((err) => console.error(`[scp-boosts] notice ${type} failed:`, (err as Error)?.message ?? err));
    }
  } catch (err) {
    console.error("[scp-boosts] social.boost.decided failed:", (err as Error)?.message ?? err);
  }
}

/** `social.budget.decided` to the proposer and the officer, href the client page's plan tab. */
export async function notifyBudgetDecided(tenantId: string, actorId: string | null, p: { requestedBy: string; engagementId: string; proposalId: string }, officerId: string | null, action: string): Promise<void> {
  try {
    const base = await socialDeptBase(tenantId);
    const type = "social.budget.decided";
    for (const id of new Set([p.requestedBy, officerId].filter((x): x is string => !!x))) {
      await notify(tenantId, id, actorId, type, {
        title: TITLES[type], ...(base ? { href: `${base}/profile/${p.engagementId}?tab=plan` } : {}),
        entityType: "social_engagement", entityId: p.engagementId, severity: "info", action, proposalId: p.proposalId,
      }).catch((err) => console.error(`[scp-boosts] notice ${type} failed:`, (err as Error)?.message ?? err));
    }
  } catch (err) {
    console.error("[scp-boosts] social.budget.decided failed:", (err as Error)?.message ?? err);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The request (`request_boost`)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface BoostRequestAnswer {
  boost: BoostRow;
  remainingMinor: number;
  needsClient: boolean;
  created: boolean;
}

/** The cycle's remaining, or 0 with no cycle. */
async function remainingFor(c: PoolClient, tenantId: string, cycleId: string | null): Promise<number> {
  return cycleId ? (await readCycleMoney(c, tenantId, cycleId)).remainingMinor : 0;
}

/** A replayed request: the boost as it stands. */
async function replayAnswer(tenantId: string, boostId: string): Promise<BoostRequestAnswer> {
  return withTenants([tenantId], async (c) => {
    const boost = (await readBoostRow(c, tenantId, boostId))!;
    return { boost, remainingMinor: await remainingFor(c, tenantId, boost.cycleId), needsClient: boost.status === "requested", created: false };
  }, SOCIAL);
}

const pgCode = (e: unknown): { code?: string; constraint?: string } => (e && typeof e === "object" ? (e as { code?: string; constraint?: string }) : {});

/** `POST posts/:postId/boosts` (§63.11). */
export async function requestBoost(principal: Principal, tenantId: string, postId: string, body: unknown): Promise<BoostRequestAnswer> {
  if (!UUID_RE.test(postId)) throw new ScpRouteError(404, "post_not_found");
  const pre = await withTenants([tenantId], async (c) => {
    const authz = await loadSocialPostAuthz(c, tenantId, postId);
    return authz ? { authz, engagement: await loadEngagement(c, tenantId, authz.engagementId) } : null;
  }, SOCIAL);
  if (!pre || !pre.engagement) throw new ScpRouteError(404, "post_not_found");
  const callerId = await authorizeCoded(principal, socialPostResource(tenantId, pre.authz), "boost", "not_officer_or_approver");

  const b = parseBoostRequest(body);
  if (b.id) {
    const existing = await withTenants([tenantId], (c) => loadRawBoost(c, tenantId, b.id!));
    if (existing && existing.postId !== postId) throw bad("id");
    if (existing) return replayAnswer(tenantId, existing.id);
  }
  if (pre.authz.pipelineStatus === null) throw new ScpRouteError(409, "not_a_pipeline_post");

  const engagement = pre.engagement;
  const boostId = b.id ?? newId();
  const total = b.dailyBudgetMinor * b.days;
  let out: { boost: BoostRow; remainingMinor: number; needsClient: boolean; cycleId: string | null };
  try {
    out = await withTenants([tenantId], async (c) => {
      // The budget cycle first (the month starts_on falls in), then its lock, BEFORE anything about money is read.
      const cycleId = await budgetCycleFor(c, tenantId, engagement.id, b.startsOn);
      await lockBoostCycle(c, cycleId);
      // post_live, judged on the share-locked row: the post cannot leave `live` while the boost is written.
      const post = (await c.query<{ pipeline_status: string | null; archived_at: Date | null; simulated: boolean }>(
        `SELECT pipeline_status, archived_at, simulated FROM social_posts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE`,
        [tenantId, postId])).rows[0];
      if (!post) throw new ScpRouteError(404, "post_not_found");
      if (post.pipeline_status !== "live" || post.archived_at !== null) throw new ScpRouteError(409, "post_not_live");
      // no_open_boost
      const open = await c.query(`SELECT 1 FROM social_boosts WHERE tenant_id = $1 AND post_id = $2 AND status = ANY($3::text[]) LIMIT 1`,
        [tenantId, postId, OPEN_BOOST_STATUSES]);
      if ((open.rowCount ?? 0) > 0) throw new ScpRouteError(409, "open_boost_exists");
      // currency_matches_budget: a boost with a budget cycle is in that cycle's budget currency, so committed never mixes currencies.
      const money: CycleMoney | null = cycleId ? await readCycleMoney(c, tenantId, cycleId) : null;
      const currency = b.currency ?? money?.currency ?? DEFAULT_CURRENCY;
      if (money && currency !== money.currency) throw new ScpRouteError(409, "currency_mismatch");

      const fits = money !== null && fitsRemaining(money.agreed?.amountMinor ?? null, money.committedMinor, total);
      const estimate = await estimateReach(c, tenantId, { clientId: engagement.client_id, simulated: post.simulated, currency, totalMinor: total });
      await c.query(
        `INSERT INTO social_boosts
           (id, tenant_id, post_id, client_id, cycle_id, status, goal, audience, audience_note, daily_budget_minor, days, currency, starts_on,
            reach_estimate_low, reach_estimate_high, requested_by, approved_via, approved_by, approved_at, budget_id, simulated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14, $15, $16, $17, $18,
                 CASE WHEN $17::text IS NULL THEN NULL ELSE now() END, $19, $20)`,
        [boostId, tenantId, postId, engagement.client_id, cycleId, fits ? "approved" : "requested", b.goal, b.audience, b.audienceNote,
          b.dailyBudgetMinor, b.days, currency, b.startsOn, estimate.reachLow, estimate.reachHigh, callerId,
          fits ? "budget" : null, fits ? callerId : null, fits ? money!.agreed!.id : null, post.simulated],
      );
      const boost = (await readBoostRow(c, tenantId, boostId))!;
      return { boost, remainingMinor: await remainingFor(c, tenantId, cycleId), needsClient: !fits, cycleId };
    }, SOCIAL);
  } catch (e) {
    const pg = pgCode(e);
    if (pg.code === "23505" && pg.constraint === "ux_social_boosts_open_post") throw new ScpRouteError(409, "open_boost_exists");
    if (pg.code === "23505" && pg.constraint === "social_boosts_pkey" && b.id) {
      // The same id raced in: a replay when it is this post's, else an id taken elsewhere.
      const existing = await withTenants([tenantId], (c) => loadRawBoost(c, tenantId, b.id!));
      if (existing && existing.postId === postId) return replayAnswer(tenantId, existing.id);
      throw bad("id");
    }
    throw e;
  }

  await writeActivity(tenantId, callerId, "request_boost", "social_post", postId, {
    boostId, cycleId: out.cycleId, engagementId: engagement.id, from: null, to: out.boost.status,
    ...(out.boost.approvedVia ? { approvedVia: out.boost.approvedVia } : {}), viaPortal: false,
  });
  if (out.needsClient) {
    await notifyClientContacts(tenantId, callerId, engagement.client_id, engagement.project_id, true, "social.boost.waiting_client",
      { entityType: "social_boost", entityId: boostId, action: "request_boost" });
  }
  return { boost: out.boost, remainingMinor: out.remainingMinor, needsClient: out.needsClient, created: true };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A boost's transitions (`cancel_boost`, `start_boost`, `stop_boost`, `complete_boost`, `record_boost_approval`, `record_boost_decline`)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface BoostTransition {
  action: BoostRouteAction;
  /** The route always passes it (required, §63.0); a system caller (SCP-Se) may leave it out. */
  expectedStatus?: string;
  actionId?: string;
  params: BoostTransitionParams;
  /** The person, or null for the system (the simulator). */
  actorId: string | null;
  /** Refuse (throw) unless the boost is simulated: the simulator's guard. */
  onlySimulated?: boolean;
}

export interface BoostTransitionResult {
  /** False for a replayed `actionId`: nothing was written. */
  applied: boolean;
  before: RawBoost;
  boost: BoostRow;
  remainingMinor: number;
  warnings: string[];
}

/** Whether `actionId` was already applied to this boost as `action` (its activity row carries it). */
async function actionAlreadyApplied(c: PoolClient, tenantId: string, b: RawBoost, action: string, actionId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM activities WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2 AND verb = $3
        AND metadata->>'boostId' = $4 AND metadata->>'actionId' = $5 LIMIT 1`,
    [tenantId, b.postId, action, b.id, actionId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * One transition on one boost, inside the caller's transaction (which must declare the social module scope). Takes the cycle lock first,
 * then the row `FOR UPDATE`; judges `expectedStatus` (409 `boost_status_changed`), then the fixture's `from` (409 `boost_not_waiting` for
 * the two record actions, `invalid_boost_transition` otherwise); writes; answers the boost after. A spend above the boost's total budget
 * answers `warnings: ['spend_above_budget']` (stop and complete).
 */
export async function applyBoostTransitionInTx(c: PoolClient, tenantId: string, boostId: string, t: BoostTransition): Promise<BoostTransitionResult> {
  const first = await loadRawBoost(c, tenantId, boostId);
  if (!first) throw new ScpRouteError(404, "boost_not_found");
  // A boost's cycle never changes, so the unlocked read names the right lock.
  await lockBoostCycle(c, first.cycleId);
  const before = (await loadRawBoost(c, tenantId, boostId, true))!;
  if (t.onlySimulated && !before.simulated) throw new Error(`scp-boosts: ${t.action} on boost ${boostId} refused: not a simulated boost`);
  const fx = boostFixtureAction(t.action);
  if (!fx) throw new Error(`scp-boosts: '${t.action}' is not a fixture boost action`);

  const finish = async (applied: boolean, warnings: string[]): Promise<BoostTransitionResult> => ({
    applied, before, boost: (await readBoostRow(c, tenantId, boostId))!, remainingMinor: await remainingFor(c, tenantId, before.cycleId), warnings,
  });

  if (t.expectedStatus !== undefined && before.status !== t.expectedStatus) {
    if (t.actionId && (await actionAlreadyApplied(c, tenantId, before, t.action, t.actionId))) return finish(false, []);
    throw new ScpRouteError(409, "boost_status_changed", { detail: { status: before.status } });
  }
  if (!(fx.from ?? []).includes(before.status)) {
    if (BOOST_RECORD_ACTIONS.has(t.action)) throw new ScpRouteError(409, "boost_not_waiting");
    throw new ScpRouteError(409, "invalid_boost_transition", { detail: { status: before.status } });
  }

  const p = t.params;
  const actor = t.actorId;
  const warnings: string[] = [];
  const set = async (sql: string, values: unknown[]) => {
    const r = await c.query(`UPDATE social_boosts SET ${sql}, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = $3`,
      [tenantId, boostId, before.status, ...values]);
    if ((r.rowCount ?? 0) !== 1) throw new Error(`scp-boosts: ${t.action} on ${boostId} wrote ${r.rowCount} rows under its own lock`);
  };
  switch (t.action) {
    case "cancel_boost":
      await set(`status = 'cancelled', cancelled_at = now(), cancelled_by = $4, cancel_reason = $5`, [actor, p.reason ?? null]);
      break;
    case "start_boost":
      await set(`status = 'running', started_at = now(), started_by = $4`, [actor]);
      break;
    case "stop_boost":
      await set(
        `status = 'stopped', ended_at = now(), ended_by = $4, spend_minor = $5, paid_reach = $6, clicks = $7, results_entered_by = $4`,
        [actor, p.spendMinor, p.paidReach ?? null, p.clicks ?? null]);
      if ((p.spendMinor ?? 0) > before.totalMinor) warnings.push("spend_above_budget");
      break;
    case "complete_boost":
      // From `stopped` the end stays when it was; the results are the final ones.
      await set(
        `status = 'completed', ended_at = COALESCE(ended_at, now()), ended_by = COALESCE(ended_by, $4), spend_minor = $5, paid_reach = $6,
         clicks = COALESCE($7, clicks), results_entered_by = $4`,
        [actor, p.spendMinor, p.paidReach, p.clicks ?? null]);
      if ((p.spendMinor ?? 0) > before.totalMinor) warnings.push("spend_above_budget");
      break;
    case "record_boost_approval":
      await set(`status = 'approved', approved_via = 'recorded', approved_by = $4, approved_at = now(), approval_channel = $5, approval_note = $6`,
        [actor, p.channel, p.note]);
      break;
    case "record_boost_decline":
      // The channel of the client's recorded answer is kept in approval_channel (the table has no decline channel; §63.1 file 7).
      await set(`status = 'declined', declined_at = now(), declined_via = 'recorded', declined_by = $4, decline_note = $5, approval_channel = $6`,
        [actor, p.note, p.channel]);
      break;
  }
  return finish(true, warnings);
}

/** One transition in its own transaction. */
export async function runBoostTransition(tenantId: string, boostId: string, t: BoostTransition): Promise<BoostTransitionResult> {
  return withTenants([tenantId], (c) => applyBoostTransitionInTx(c, tenantId, boostId, t), SOCIAL);
}

/** The activity row of a boost transition (after the commit). Never a note's text. */
async function writeBoostActivity(tenantId: string, actorId: string | null, action: string, r: BoostTransitionResult, engagementId: string | null, extra: Record<string, unknown>): Promise<void> {
  await writeActivity(tenantId, actorId, action, "social_post", r.before.postId, {
    boostId: r.before.id, cycleId: r.before.cycleId, engagementId, from: r.before.status, to: r.boost.status,
    ...(r.boost.approvedVia && action !== "cancel_boost" ? { approvedVia: r.boost.approvedVia } : {}), ...extra,
  });
}

async function engagementOfPost(tenantId: string, postId: string): Promise<EngagementRow | null> {
  return withTenants([tenantId], async (c) => {
    const r = await c.query<{ engagement_id: string }>(`SELECT engagement_id::text AS engagement_id FROM social_posts WHERE tenant_id = $1 AND id = $2`, [tenantId, postId]);
    return r.rows[0] ? loadEngagement(c, tenantId, r.rows[0].engagement_id) : null;
  }, SOCIAL);
}

/**
 * SCP-Se's entry point: start an `approved` boost with no person behind it (actor NULL), through the route's own transition. With
 * `onlySimulated` (the simulator always passes it) a real boost is refused. Writes the `start_boost` activity with actor NULL and
 * `metadata.viaSimulator`.
 */
export async function startBoost(tenantId: string, boostId: string, o: { onlySimulated: boolean; expectedStatus?: "approved" }): Promise<BoostTransitionResult> {
  const r = await runBoostTransition(tenantId, boostId, { action: "start_boost", expectedStatus: o.expectedStatus ?? "approved", params: {}, actorId: null, onlySimulated: o.onlySimulated });
  if (r.applied) {
    const eng = await engagementOfPost(tenantId, r.before.postId);
    await writeBoostActivity(tenantId, null, "start_boost", r, eng?.id ?? null, { viaSimulator: true, simulated: r.boost.simulated, viaPortal: false });
  }
  return r;
}

/**
 * SCP-Se's entry point: complete a `running` (or `stopped`) boost with its results and no person behind it (actor NULL), through the route's
 * own transition (cycle lock, row lock, the fixture's `from`). With `onlySimulated` a real boost is refused.
 */
export async function completeBoost(
  tenantId: string, boostId: string,
  o: { spendMinor: number; paidReach: number; clicks?: number | null; onlySimulated: boolean; expectedStatus?: "running" | "stopped" },
): Promise<BoostTransitionResult> {
  const r = await runBoostTransition(tenantId, boostId, {
    action: "complete_boost", expectedStatus: o.expectedStatus, params: { spendMinor: o.spendMinor, paidReach: o.paidReach, clicks: o.clicks ?? null },
    actorId: null, onlySimulated: o.onlySimulated,
  });
  if (r.applied) {
    const eng = await engagementOfPost(tenantId, r.before.postId);
    await writeBoostActivity(tenantId, null, "complete_boost", r, eng?.id ?? null, { viaSimulator: true, simulated: r.boost.simulated, viaPortal: false });
  }
  return r;
}

export interface BoostActionAnswer {
  boost: BoostRow;
  remainingMinor: number;
  warnings: string[];
  alreadyApplied?: true;
}

/** `POST boosts/:boostId/actions` (§63.11). */
export async function boostAction(principal: Principal, tenantId: string, boostId: string, body: unknown): Promise<BoostActionAnswer> {
  if (!UUID_RE.test(boostId)) throw new ScpRouteError(404, "boost_not_found");
  const pre = await withTenants([tenantId], async (c) => {
    const raw = await loadRawBoost(c, tenantId, boostId);
    const authz = raw ? await loadSocialPostAuthz(c, tenantId, raw.postId) : null;
    return raw && authz ? { raw, authz } : null;
  }, SOCIAL);
  if (!pre) throw new ScpRouteError(404, "boost_not_found");
  const b = isObj(body) ? body : {};
  const action = b.action;

  let callerId: string;
  if (typeof action !== "string" || !(BOOST_ROUTE_ACTIONS as readonly string[]).includes(action)) {
    // Without a known action there is no gate to ask. A caller who holds neither `boost` nor `budget` is refused (403) rather than told
    // about the body; anyone else learns the action is missing or unknown.
    if (isAutomationPrincipal(principal)) throw new ScpRouteError(403, "automation_cannot_act");
    const mayBoost = (await check(principal, socialPostResource(tenantId, pre.authz), "boost")).allow;
    const mayBudget = mayBoost || (await check(principal, socialEngagementResource(tenantId, pre.authz.approverIds, pre.authz.engagementId), "budget")).allow;
    if (!mayBudget) {
      await authorizeCoded(principal, socialPostResource(tenantId, pre.authz), "boost", "not_officer_or_approver"); // audits and throws 403
    }
    if (absent(action) || action === "") throw bad("action", "missing_field");
    throw new ScpRouteError(400, "unknown_action", { field: "action" });
  }
  const act = action as BoostRouteAction;
  if (BOOST_RECORD_ACTIONS.has(act)) callerId = await authorizeBudget(principal, tenantId, pre.authz.approverIds, pre.authz.engagementId);
  else callerId = await authorizeCoded(principal, socialPostResource(tenantId, pre.authz), "boost", "not_officer_or_approver");

  // The body, after the decision.
  if (absent(b.expectedStatus) || b.expectedStatus === "") throw bad("expectedStatus", "missing_field");
  if (typeof b.expectedStatus !== "string" || !(BOOST_STATUSES as readonly string[]).includes(b.expectedStatus)) throw bad("expectedStatus");
  if (!absent(b.actionId) && (typeof b.actionId !== "string" || !UUID_RE.test(b.actionId))) throw bad("actionId");
  const actionId = typeof b.actionId === "string" ? b.actionId.toLowerCase() : undefined;
  const params = parseTransitionParams(act, b);

  const r = await runBoostTransition(tenantId, boostId, { action: act, expectedStatus: b.expectedStatus, actionId, params, actorId: callerId });
  if (!r.applied) return { boost: r.boost, remainingMinor: r.remainingMinor, warnings: [], alreadyApplied: true };

  await writeBoostActivity(tenantId, callerId, act, r, pre.authz.engagementId, {
    ...(params.channel ? { channel: params.channel } : {}), ...(actionId ? { actionId } : {}), viaPortal: false,
  });
  if (BOOST_RECORD_ACTIONS.has(act)) {
    await notifyBoostDecided(tenantId, callerId, { postId: r.before.postId, requestedBy: r.before.requestedBy }, pre.authz.ownerId || null, act);
  }
  return { boost: r.boost, remainingMinor: r.remainingMinor, warnings: r.warnings };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The monthly budget (staff): the read, a proposal, a withdrawal, a recording
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface Person { id: string; name: string }

/** One proposal or recording as the read shows it. */
export interface Proposal {
  id: string;
  amountMinor: number;
  currency: string;
  minorUnit: number;
  status: string;
  via: "portal" | "recorded" | null;
  note: string | null;
  requestedAt: string;
  requestedBy: Person | null;
  decidedAt: string | null;
  /** The contact who decided in the portal, or the approver who recorded it. */
  decidedBy: Person | null;
  channel: string | null;
  decisionNote: string | null;
}

export interface BoostBudgetAnswer {
  cycleId: string;
  agreed: { id: string; amountMinor: number; currency: string; minorUnit: number; via: "portal" | "recorded" | null; agreedAt: string | null; agreedBy: Person | null; channel?: string } | null;
  pending: Proposal | null;
  committedMinor: number;
  remainingMinor: number;
  currency: string;
  minorUnit: number;
  history: Proposal[];
  canRecord: boolean;
}

async function budgetAnswer(c: PoolClient, tenantId: string, cycleId: string, canRecord: boolean): Promise<BoostBudgetAnswer> {
  const money = await readCycleMoney(c, tenantId, cycleId);
  const rows = await loadCycleBudgets(c, tenantId, cycleId);
  const names = await userNames(c, rows.flatMap((r) => [r.requestedBy, r.decidedBy, r.recordedBy]));
  const person = (id: string | null): Person | null => (id ? { id, name: names.get(id) ?? "Someone" } : null);
  const units = new Map<string, number>();
  for (const cur of new Set([money.currency, ...rows.map((r) => r.currency)])) units.set(cur, await minorUnitOf(c, cur));
  const proposalOf = (r: BudgetRow): Proposal => ({
    id: r.id, amountMinor: r.amountMinor, currency: r.currency, minorUnit: units.get(r.currency) ?? 0, status: r.status, via: r.decidedVia,
    note: r.requestNote, requestedAt: r.requestedAt, requestedBy: person(r.requestedBy), decidedAt: r.decidedAt,
    decidedBy: person(r.decidedVia === "recorded" ? r.recordedBy : r.decidedBy), channel: r.channel, decisionNote: r.decisionNote,
  });
  const a = money.agreed;
  return {
    cycleId,
    agreed: a ? {
      id: a.id, amountMinor: a.amountMinor, currency: a.currency, minorUnit: units.get(a.currency) ?? 0, via: a.decidedVia, agreedAt: a.decidedAt,
      agreedBy: person(a.decidedVia === "recorded" ? a.recordedBy : a.decidedBy), ...(a.channel ? { channel: a.channel } : {}),
    } : null,
    pending: money.pending ? proposalOf(money.pending) : null,
    committedMinor: money.committedMinor,
    remainingMinor: money.remainingMinor,
    currency: money.currency,
    minorUnit: units.get(money.currency) ?? 0,
    history: rows.map(proposalOf),
    canRecord,
  };
}

/** The cycle's engagement and the company's approvers, or 404 `cycle_not_found`. */
async function seeCycle(tenantId: string, cycleId: string): Promise<{ engagement: EngagementRow; approverIds: string[] }> {
  if (!UUID_RE.test(cycleId)) throw new ScpRouteError(404, "cycle_not_found");
  const seen = await withTenants([tenantId], async (c) => {
    const cyc = await cycleEngagement(c, tenantId, cycleId, true);
    const engagement = cyc ? await loadEngagement(c, tenantId, cyc.engagementId) : null;
    return engagement ? { engagement, approverIds: await loadSocialApproverIds(c, tenantId) } : null;
  }, SOCIAL);
  if (!seen) throw new ScpRouteError(404, "cycle_not_found");
  return seen;
}

/** `GET cycles/:cycleId/boost-budget` (§63.11): `social_post` · `read`. */
export async function readBoostBudget(principal: Principal, tenantId: string, cycleId: string): Promise<BoostBudgetAnswer> {
  const seen = await seeCycle(tenantId, cycleId);
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  const canRecord = await canRecordOf(principal, tenantId, seen.approverIds, seen.engagement.id);
  return withTenants([tenantId], (c) => budgetAnswer(c, tenantId, cycleId, canRecord), SOCIAL);
}

const belowCommitted = (committedMinor: number, currency: string) => new ScpRouteError(409, "budget_below_committed", { detail: { committedMinor, currency } });

/** `POST cycles/:cycleId/boost-budget/proposals` (§63.11): `{amountMinor, note?}`. 201 with the budget read and the new `proposalId`. */
export async function proposeBoostBudget(principal: Principal, tenantId: string, cycleId: string, body: unknown): Promise<BoostBudgetAnswer & { proposalId: string }> {
  const seen = await seeCycle(tenantId, cycleId);
  const callerId = await authorizeBudget(principal, tenantId, seen.approverIds, seen.engagement.id);
  const b = isObj(body) ? body : {};
  const amountMinor = intField(b, "amountMinor", 0, MAX_MINOR, true)!;
  const note = textField(b, "note", 1000, false);

  const proposalId = newId();
  let answer: BoostBudgetAnswer;
  try {
    answer = await withTenants([tenantId], async (c) => {
      await lockBoostCycle(c, cycleId);
      const money = await readCycleMoney(c, tenantId, cycleId);
      if (money.pending) throw new ScpRouteError(409, "proposal_pending");
      if (amountMinor < money.committedMinor) throw belowCommitted(money.committedMinor, money.currency);
      await c.query(
        `INSERT INTO social_boost_budgets (id, tenant_id, client_id, cycle_id, amount_minor, currency, status, requested_by, request_note)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
        [proposalId, tenantId, seen.engagement.client_id, cycleId, amountMinor, money.currency, callerId, note]);
      return budgetAnswer(c, tenantId, cycleId, true);
    }, SOCIAL);
  } catch (e) {
    const pg = pgCode(e);
    if (pg.code === "23505" && pg.constraint === "ux_social_boost_budgets_pending") throw new ScpRouteError(409, "proposal_pending");
    throw e;
  }
  await writeActivity(tenantId, callerId, "propose_boost_budget", "social_engagement", seen.engagement.id, { cycleId, proposalId, viaPortal: false });
  await notifyClientContacts(tenantId, callerId, seen.engagement.client_id, seen.engagement.project_id, true, "social.budget.proposed",
    { entityType: "social_boost_budget", entityId: proposalId, action: "propose_boost_budget" });
  return { ...answer, proposalId };
}

/** `POST boost-budget/proposals/:proposalId/withdraw` (§63.11). 200 with the budget read. */
export async function withdrawBoostBudget(principal: Principal, tenantId: string, proposalId: string): Promise<BoostBudgetAnswer> {
  if (!UUID_RE.test(proposalId)) throw new ScpRouteError(404, "proposal_not_found");
  const seen = await withTenants([tenantId], async (c) => {
    const row = await loadBudget(c, tenantId, proposalId);
    const cyc = row ? await cycleEngagement(c, tenantId, row.cycleId) : null;
    return row && cyc ? { row, engagementId: cyc.engagementId, approverIds: await loadSocialApproverIds(c, tenantId) } : null;
  }, SOCIAL);
  if (!seen) throw new ScpRouteError(404, "proposal_not_found");
  const callerId = await authorizeBudget(principal, tenantId, seen.approverIds, seen.engagementId);

  const cycleId = seen.row.cycleId;
  const answer = await withTenants([tenantId], async (c) => {
    await lockBoostCycle(c, cycleId);
    const cur = (await loadBudget(c, tenantId, proposalId, true))!;
    if (cur.status !== "pending") throw new ScpRouteError(409, "budget_already_decided");
    await c.query(`UPDATE social_boost_budgets SET status = 'withdrawn', decided_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
      [tenantId, proposalId]);
    return budgetAnswer(c, tenantId, cycleId, true);
  }, SOCIAL);
  await writeActivity(tenantId, callerId, "withdraw_boost_budget", "social_engagement", seen.engagementId, { cycleId, proposalId, viaPortal: false });
  return answer;
}

/**
 * `POST cycles/:cycleId/boost-budget/record` (§63.11): `{amountMinor, channel, note}`, the client's agreement given outside the portal, to
 * set, raise or lower the budget (never below committed). A pending proposal becomes `superseded`, and so does the previous agreement; the new
 * row is the cycle's one `agreed` row. 201 with the budget read and the new row's id as `proposalId`.
 */
export async function recordBoostBudget(principal: Principal, tenantId: string, cycleId: string, body: unknown): Promise<BoostBudgetAnswer & { proposalId: string }> {
  const seen = await seeCycle(tenantId, cycleId);
  const callerId = await authorizeBudget(principal, tenantId, seen.approverIds, seen.engagement.id);
  const b = isObj(body) ? body : {};
  const amountMinor = intField(b, "amountMinor", 0, MAX_MINOR, true)!;
  const channel = enumField(b, "channel", RECORD_CHANNELS, true)!;
  const note = textField(b, "note", 2000, true)!;

  const id = newId();
  const answer = await withTenants([tenantId], async (c) => {
    await lockBoostCycle(c, cycleId);
    const money = await readCycleMoney(c, tenantId, cycleId);
    if (amountMinor < money.committedMinor) throw belowCommitted(money.committedMinor, money.currency);
    // The previous agreement and any pending proposal step aside FIRST (the partial unique allows one agreed row per cycle).
    await c.query(
      `UPDATE social_boost_budgets SET status = 'superseded', decided_at = COALESCE(decided_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND cycle_id = $2 AND status IN ('pending','agreed')`,
      [tenantId, cycleId]);
    await c.query(
      `INSERT INTO social_boost_budgets
         (id, tenant_id, client_id, cycle_id, amount_minor, currency, status, requested_by, decided_via, recorded_by, channel, decision_note, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'agreed', $7, 'recorded', $7, $8, $9, now())`,
      [id, tenantId, seen.engagement.client_id, cycleId, amountMinor, money.currency, callerId, channel, note]);
    return budgetAnswer(c, tenantId, cycleId, true);
  }, SOCIAL);
  await writeActivity(tenantId, callerId, "record_boost_budget", "social_engagement", seen.engagement.id, { cycleId, proposalId: id, channel, viaPortal: false });
  await notifyClientContacts(tenantId, callerId, seen.engagement.client_id, seen.engagement.project_id, false, "social.budget.recorded",
    { entityType: "social_boost_budget", entityId: id, action: "record_boost_budget" });
  return { ...answer, proposalId: id };
}

// Re-exported for the controllers and tests.
export type { SocialPostAuthz };
