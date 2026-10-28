// SCP-4a — the client's money answers in the portal (BFF §63.11 "The portal's approvals"; fixture `approve_boost`, `decline_boost`,
// `agree_boost_budget`, `decline_boost_budget`; rulings SCP-Q11, SCP-Q14, SCP-Q15). Thin routes in core/social-spend-portal.controller.ts.
//
//   GET  portal/social/spend                               portal · read            {budgets, boosts, history, canDecide}
//   POST portal/social/spend/budgets/:proposalId/decide    portal · approve_spend   {decision: 'agree'|'decline', note?}
//   POST portal/social/spend/boosts/:boostId/decide        portal · approve_spend   {decision: 'approve'|'decline', note?}
//
// THE ORDER OF CHECKS on both decisions (§63.11 "The rules for both"):
//   1. Cerbos `portal` · `approve_spend` on `{kind: "portal", tenantId}` (`authorize()`: audited, the revoked-session check);
//   2. the target's client in the caller's portal scope (`resolvePortalScope`), else 404 `proposal_not_found` / `boost_not_found` (no
//      existence oracle: another client's target is absent, never forbidden);
//   3. SIGNING capability on THAT client (`canSignFor`, the very check `requireSignerFor` makes), else 403 `view_only` (SCP-Q14: signers only,
//      because it commits the client's money; a viewer sees the request but cannot agree);
//   4. the body (400 `{field}`);
//   5. under the cycle lock (boosts-data.ts) with the row `FOR UPDATE`: a replay of the same decision answers 200 `{alreadyDecided: true}`, a
//      different decision 409 `budget_already_decided` / `boost_already_decided`; a target that left `pending` / `requested` without a client
//      decision (withdrawn, superseded by a recording, approved within the budget, cancelled) is 409 `budget_already_decided` /
//      `boost_not_waiting`; agreeing a budget re-checks committed AT THAT MOMENT (409 `budget_below_committed`, `detail {committedMinor,
//      currency}`; lowering down to exactly committed is allowed) and makes the previous agreement `superseded`.
//
// THE WALL. `social_boosts` and `social_boost_budgets` are plain-walled, so the decision itself needs no module scope, and the lock is keyed on
// the cycle id those rows carry (the portal never reads `social_cycles` to take it). The READ joins the post's title, the design thumbnail and
// the cycle's month, which are third-walled social tables: it declares the module scope (`{ modules: ["social"] }`), as every portal social
// read does (§63.0).
//
// WHAT THE CLIENT NEVER SEES. Only the client's own budgets, boosts and spend: no fee, no margin, no staff note, no internal status
// (PV-D38). The request note of a proposal is the approver's message to the client, so it is shown.
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import { canSignFor, resolvePortalScope, type PortalScope } from "../../../core/portal-scope";
import { check, type Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";
import { ScpRouteError } from "./pipeline-effects";
import { loadEngagement } from "./pipeline-data";
import { notifyBoostDecided, notifyBudgetDecided } from "./boosts";
import { cycleEngagement, loadBudget, loadRawBoost, lockBoostCycle, minorUnitSql, readCommitted, readCycleMoney } from "./boosts-data";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const portalResource = (tenantId: string): Resource => ({ kind: "portal", tenantId });
const bad = (field: string, code: "missing_field" | "invalid_field" = "invalid_field") => new ScpRouteError(400, code, { field });
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** The decision body: `decision` from `allowed`, an optional note of 1 to 2,000 characters. */
function parseDecisionBody<T extends string>(body: unknown, allowed: readonly T[]): { decision: T; note: string | null } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.decision === undefined || b.decision === null || b.decision === "") throw bad("decision", "missing_field");
  if (typeof b.decision !== "string" || !(allowed as readonly string[]).includes(b.decision)) throw bad("decision");
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && b.note !== "") {
    if (typeof b.note !== "string" || b.note.trim() === "" || [...b.note.trim()].length > 2000) throw bad("note");
    note = b.note.trim();
  }
  return { decision: b.decision as T, note };
}

/** Steps 1 and the person: Cerbos `approve_spend`, and an authenticated contact. */
async function authorizeSpend(principal: Principal, tenantId: string): Promise<string> {
  await authorize(principal, portalResource(tenantId), "approve_spend");
  if (!principal.userId) throw new ForbiddenException("not authorized: an authenticated user is required");
  return principal.userId;
}

const viewOnly = () => new ScpRouteError(403, "view_only");

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// GET portal/social/spend
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface PortalSpendBudget {
  proposalId: string; clientName: string; month: string | null; amountMinor: number; agreedMinor: number | null; committedMinor: number;
  currency: string; minorUnit: number; note: string | null; requestedAt: string; canDecide: boolean;
}
export interface PortalSpendBoost {
  boostId: string; clientName: string; postTitle: string | null; thumbFileId: string | null; totalBudgetMinor: number; days: number; startsOn: string;
  currency: string; minorUnit: number; remainingMinor: number; simulated: boolean; canDecide: boolean;
}
export interface PortalSpendHistory {
  kind: "budget" | "boost"; id: string; clientName: string; month: string | null; postTitle: string | null; amountMinor: number;
  currency: string; minorUnit: number; status: string; via: string | null; decidedAt: string | null;
}
export interface PortalSpend { budgets: PortalSpendBudget[]; boosts: PortalSpendBoost[]; history: PortalSpendHistory[]; canDecide: boolean }

const HISTORY_MAX = 50;

async function readSpend(c: PoolClient, tenantId: string, scope: PortalScope): Promise<Omit<PortalSpend, "canDecide">> {
  const clientIds = scope.clientIds;
  const budgets = await c.query<{
    id: string; client_id: string; client_name: string; cycle_id: string; month: string | null; amount_minor: string; currency: string; minor_unit: number;
    request_note: string | null; requested_at: Date;
  }>(
    `SELECT b.id::text AS id, b.client_id::text AS client_id, cl.name AS client_name, b.cycle_id::text AS cycle_id,
            to_char(sc.month, 'YYYY-MM') AS month, b.amount_minor::text AS amount_minor, b.currency::text AS currency,
            ${minorUnitSql("b.currency")} AS minor_unit, b.request_note, b.requested_at
       FROM social_boost_budgets b
       JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id
       LEFT JOIN social_cycles sc ON sc.tenant_id = b.tenant_id AND sc.id = b.cycle_id
      WHERE b.tenant_id = $1 AND b.client_id = ANY($2::uuid[]) AND b.status = 'pending'
      ORDER BY b.requested_at, b.id`,
    [tenantId, clientIds]);
  const boosts = await c.query<{
    id: string; client_id: string; client_name: string; cycle_id: string | null; title: string | null; thumb: string | null; total: string; days: number;
    starts_on: string; currency: string; minor_unit: number; simulated: boolean;
  }>(
    `SELECT b.id::text AS id, b.client_id::text AS client_id, cl.name AS client_name, b.cycle_id::text AS cycle_id, p.title,
            (SELECT COALESCE(d.thumb_file_id, d.file_id)::text FROM social_post_designs d
              WHERE d.tenant_id = b.tenant_id AND d.post_id = b.post_id AND d.removed_at IS NULL AND d.file_id IS NOT NULL
              ORDER BY d.position LIMIT 1) AS thumb,
            b.total_budget_minor::text AS total, b.days, b.starts_on::text AS starts_on, b.currency::text AS currency,
            ${minorUnitSql("b.currency")} AS minor_unit, b.simulated
       FROM social_boosts b
       JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id
       LEFT JOIN social_posts p ON p.tenant_id = b.tenant_id AND p.id = b.post_id
      WHERE b.tenant_id = $1 AND b.client_id = ANY($2::uuid[]) AND b.status = 'requested'
      ORDER BY b.requested_at, b.id`,
    [tenantId, clientIds]);
  const history = await c.query<{
    kind: "budget" | "boost"; id: string; client_name: string; month: string | null; title: string | null; amount: string; currency: string;
    minor_unit: number; status: string; via: string | null; decided_at: Date | null;
  }>(
    `SELECT * FROM (
       SELECT 'budget' AS kind, b.id::text AS id, cl.name AS client_name, to_char(sc.month, 'YYYY-MM') AS month, NULL::text AS title,
              b.amount_minor::text AS amount, b.currency::text AS currency, ${minorUnitSql("b.currency")} AS minor_unit, b.status,
              b.decided_via AS via, b.decided_at
         FROM social_boost_budgets b
         JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id
         LEFT JOIN social_cycles sc ON sc.tenant_id = b.tenant_id AND sc.id = b.cycle_id
        WHERE b.tenant_id = $1 AND b.client_id = ANY($2::uuid[]) AND b.decided_via IS NOT NULL
       UNION ALL
       SELECT 'boost', b.id::text, cl.name, NULL::text, p.title, b.total_budget_minor::text, b.currency::text, ${minorUnitSql("b.currency")},
              b.status, COALESCE(b.approved_via, b.declined_via), COALESCE(b.declined_at, b.approved_at)
         FROM social_boosts b
         JOIN clients cl ON cl.id = b.client_id AND cl.tenant_id = b.tenant_id
         LEFT JOIN social_posts p ON p.tenant_id = b.tenant_id AND p.id = b.post_id
        WHERE b.tenant_id = $1 AND b.client_id = ANY($2::uuid[]) AND (b.approved_via IS NOT NULL OR b.declined_at IS NOT NULL)
     ) h ORDER BY h.decided_at DESC NULLS LAST, h.id LIMIT ${HISTORY_MAX}`,
    [tenantId, clientIds]);

  // Each cycle's money once (a client has a handful of open items).
  const cycles = new Map<string, Awaited<ReturnType<typeof readCycleMoney>>>();
  const moneyOf = async (cycleId: string) => {
    if (!cycles.has(cycleId)) cycles.set(cycleId, await readCycleMoney(c, tenantId, cycleId));
    return cycles.get(cycleId)!;
  };
  const outBudgets: PortalSpendBudget[] = [];
  for (const r of budgets.rows) {
    const m = await moneyOf(r.cycle_id);
    outBudgets.push({
      proposalId: r.id, clientName: r.client_name, month: r.month, amountMinor: Number(r.amount_minor), agreedMinor: m.agreed?.amountMinor ?? null,
      committedMinor: m.committedMinor, currency: r.currency, minorUnit: Number(r.minor_unit), note: r.request_note, requestedAt: iso(r.requested_at)!,
      canDecide: canSignFor(scope, r.client_id),
    });
  }
  const outBoosts: PortalSpendBoost[] = [];
  for (const r of boosts.rows) {
    outBoosts.push({
      boostId: r.id, clientName: r.client_name, postTitle: r.title, thumbFileId: r.thumb, totalBudgetMinor: Number(r.total), days: Number(r.days),
      startsOn: r.starts_on, currency: r.currency, minorUnit: Number(r.minor_unit), remainingMinor: r.cycle_id ? (await moneyOf(r.cycle_id)).remainingMinor : 0,
      simulated: r.simulated, canDecide: canSignFor(scope, r.client_id),
    });
  }
  return {
    budgets: outBudgets,
    boosts: outBoosts,
    history: history.rows.map((h) => ({
      kind: h.kind, id: h.id, clientName: h.client_name, month: h.month, postTitle: h.title, amountMinor: Number(h.amount), currency: h.currency,
      minorUnit: Number(h.minor_unit), status: h.status, via: h.via, decidedAt: iso(h.decided_at),
    })),
  };
}

/** `GET portal/social/spend` (§63.11). `canDecide`: Cerbos allows `approve_spend` and the caller signs for at least one of their clients
 *  (each item carries its own `canDecide` for its client). */
export async function portalSpend(principal: Principal, tenantId: string): Promise<PortalSpend> {
  await authorize(principal, portalResource(tenantId), "read");
  const { scope, data } = await withTenants([tenantId], async (c) => {
    const s = await resolvePortalScope(c, principal);
    return { scope: s, data: await readSpend(c, tenantId, s) };
  }, SOCIAL);
  const allowed = scope.signerClientIds.length > 0 && (await check(principal, portalResource(tenantId), "approve_spend")).allow;
  if (!allowed) {
    for (const b of data.budgets) b.canDecide = false;
    for (const b of data.boosts) b.canDecide = false;
  }
  return { ...data, canDecide: allowed };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// POST portal/social/spend/budgets/:proposalId/decide
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface PortalBudgetDecision {
  proposalId: string;
  status: string;
  agreedMinor: number | null;
  committedMinor: number;
  remainingMinor: number;
  currency: string;
  alreadyDecided?: true;
}

export async function portalDecideBudget(principal: Principal, tenantId: string, proposalId: string, body: unknown): Promise<PortalBudgetDecision> {
  const callerId = await authorizeSpend(principal, tenantId);
  if (!UUID_RE.test(proposalId)) throw new ScpRouteError(404, "proposal_not_found");
  const seen = await withTenants([tenantId], async (c) => {
    const scope = await resolvePortalScope(c, principal);
    const row = await loadBudget(c, tenantId, proposalId);
    if (!row || !scope.clientIds.includes(row.clientId)) return null;
    const cyc = await cycleEngagement(c, tenantId, row.cycleId);
    const engagement = cyc ? await loadEngagement(c, tenantId, cyc.engagementId) : null;
    return { scope, row, engagementId: cyc?.engagementId ?? null, officerId: engagement?.owner_id ?? null };
  }, SOCIAL);
  if (!seen) throw new ScpRouteError(404, "proposal_not_found");
  if (!canSignFor(seen.scope, seen.row.clientId)) throw viewOnly();
  const { decision, note } = parseDecisionBody(body, ["agree", "decline"] as const);

  const cycleId = seen.row.cycleId;
  const out = await withTenants([tenantId], async (c) => {
    await lockBoostCycle(c, cycleId);
    const cur = (await loadBudget(c, tenantId, proposalId, true))!;
    const answer = async (alreadyDecided: boolean): Promise<PortalBudgetDecision> => {
      const m = await readCycleMoney(c, tenantId, cycleId);
      const now = (await loadBudget(c, tenantId, proposalId))!;
      return {
        proposalId, status: now.status, agreedMinor: m.agreed?.amountMinor ?? null, committedMinor: m.committedMinor, remainingMinor: m.remainingMinor,
        currency: m.currency, ...(alreadyDecided ? { alreadyDecided: true as const } : {}),
      };
    };
    if (cur.status !== "pending") {
      // A client decision stands on the row (decided_via); a superseded row that WAS agreed counts as agreed.
      const same = decision === "agree"
        ? cur.decidedVia !== null && (cur.status === "agreed" || cur.status === "superseded")
        : cur.status === "declined";
      if (same) return { applied: false, answer: await answer(true) };
      throw new ScpRouteError(409, "budget_already_decided");
    }
    if (decision === "agree") {
      const committed = await readCommitted(c, tenantId, cycleId);
      if (cur.amountMinor < committed) throw new ScpRouteError(409, "budget_below_committed", { detail: { committedMinor: committed, currency: cur.currency } });
      await c.query(
        `UPDATE social_boost_budgets SET status = 'superseded', updated_at = now() WHERE tenant_id = $1 AND cycle_id = $2 AND status = 'agreed' AND id <> $3`,
        [tenantId, cycleId, proposalId]);
      await c.query(
        `UPDATE social_boost_budgets SET status = 'agreed', decided_via = 'portal', decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [tenantId, proposalId, callerId, note]);
    } else {
      await c.query(
        `UPDATE social_boost_budgets SET status = 'declined', decided_via = 'portal', decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [tenantId, proposalId, callerId, note]);
    }
    return { applied: true, answer: await answer(false) };
  }, SOCIAL);

  if (out.applied) {
    const action = decision === "agree" ? "agree_boost_budget" : "decline_boost_budget";
    if (seen.engagementId) {
      await writeActivity(tenantId, callerId, action, "social_engagement", seen.engagementId, { cycleId, proposalId, viaPortal: true });
      await notifyBudgetDecided(tenantId, callerId, { requestedBy: seen.row.requestedBy, engagementId: seen.engagementId, proposalId }, seen.officerId, action);
    }
  }
  return out.answer;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// POST portal/social/spend/boosts/:boostId/decide
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface PortalBoostDecision {
  boostId: string;
  status: string;
  remainingMinor: number;
  alreadyDecided?: true;
}

export async function portalDecideBoost(principal: Principal, tenantId: string, boostId: string, body: unknown): Promise<PortalBoostDecision> {
  const callerId = await authorizeSpend(principal, tenantId);
  if (!UUID_RE.test(boostId)) throw new ScpRouteError(404, "boost_not_found");
  const seen = await withTenants([tenantId], async (c) => {
    const scope = await resolvePortalScope(c, principal);
    const raw = await loadRawBoost(c, tenantId, boostId);
    if (!raw || !scope.clientIds.includes(raw.clientId)) return null;
    const post = await c.query<{ engagement_id: string }>(`SELECT engagement_id::text AS engagement_id FROM social_posts WHERE tenant_id = $1 AND id = $2`, [tenantId, raw.postId]);
    const engagement = post.rows[0] ? await loadEngagement(c, tenantId, post.rows[0].engagement_id) : null;
    return { scope, raw, engagementId: engagement?.id ?? null, officerId: engagement?.owner_id ?? null };
  }, SOCIAL);
  if (!seen) throw new ScpRouteError(404, "boost_not_found");
  if (!canSignFor(seen.scope, seen.raw.clientId)) throw viewOnly();
  const { decision, note } = parseDecisionBody(body, ["approve", "decline"] as const);

  const out = await withTenants([tenantId], async (c) => {
    await lockBoostCycle(c, seen.raw.cycleId);
    const cur = (await loadRawBoost(c, tenantId, boostId, true))!;
    const answer = async (alreadyDecided: boolean): Promise<PortalBoostDecision> => {
      const now = (await loadRawBoost(c, tenantId, boostId))!;
      return {
        boostId, status: now.status, remainingMinor: now.cycleId ? (await readCycleMoney(c, tenantId, now.cycleId)).remainingMinor : 0,
        ...(alreadyDecided ? { alreadyDecided: true as const } : {}),
      };
    };
    if (cur.status !== "requested") {
      const clientApproved = cur.approvedVia === "portal" || cur.approvedVia === "recorded";
      const clientDeclined = cur.declinedAt !== null;
      // No client decision on the row: it never waited (approved within the budget) or stopped waiting (cancelled).
      if (!clientApproved && !clientDeclined) throw new ScpRouteError(409, "boost_not_waiting");
      const same = decision === "approve" ? clientApproved && !clientDeclined : clientDeclined;
      if (same) return { applied: false, answer: await answer(true) };
      throw new ScpRouteError(409, "boost_already_decided");
    }
    if (decision === "approve") {
      await c.query(
        `UPDATE social_boosts SET status = 'approved', approved_via = 'portal', approved_by = $3, approved_at = now(), approval_note = $4, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'requested'`,
        [tenantId, boostId, callerId, note]);
    } else {
      await c.query(
        `UPDATE social_boosts SET status = 'declined', declined_at = now(), declined_via = 'portal', declined_by = $3, decline_note = $4, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'requested'`,
        [tenantId, boostId, callerId, note]);
    }
    return { applied: true, answer: await answer(false) };
  }, SOCIAL);

  if (out.applied) {
    const action = decision === "approve" ? "approve_boost" : "decline_boost";
    await writeActivity(tenantId, callerId, action, "social_post", seen.raw.postId, {
      boostId, cycleId: seen.raw.cycleId, engagementId: seen.engagementId, from: "requested", to: out.answer.status,
      ...(decision === "approve" ? { approvedVia: "portal" } : {}), viaPortal: true,
    });
    await notifyBoostDecided(tenantId, callerId, { postId: seen.raw.postId, requestedBy: seen.raw.requestedBy }, seen.officerId, action);
  }
  return out.answer;
}
