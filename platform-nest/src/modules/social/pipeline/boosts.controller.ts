// SCP-4a — boosts and the monthly boost budget, the staff routes (BFF §63.11). Thin: the rules are boosts.ts's and boosts-data.ts's.
//
//   GET  cycles/:cycleId/boost-budget                      social_post · read           the cycle's agreement, pending proposal, committed, remaining
//   POST cycles/:cycleId/boost-budget/proposals            social_engagement · budget   {amountMinor, note?}: a proposal for the client     201
//   POST boost-budget/proposals/:proposalId/withdraw       social_engagement · budget   withdraws a pending proposal                       200
//   POST cycles/:cycleId/boost-budget/record               social_engagement · budget   {amountMinor, channel, note}: agreed outside       201
//   GET  boosts?status=&engagementId=&cycleId=&cursor=&limit=   social_post · read      the Boosting list, its candidates and totals
//   GET  posts/:postId/boosts/estimate?dailyBudgetMinor=&days=&audience=   social_post · read (the post's)   {reachLow, reachHigh, basis}
//   POST posts/:postId/boosts                              social_post · boost          the request (approved within the budget, else asks)  201
//   POST boosts/:boostId/actions                           social_post · boost, or social_engagement · budget for the two record actions   200
//
// WHO, the ORDER of answers, the cycle lock and NO ADS BOUGHT: boosts.ts's header. The reads answer 404 for an absent target BEFORE the
// decision (there is no resource to build), then 403, then 400 for a bad query value. Every query declares the social module scope.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { loadSocialPostAuthz, socialPostResource } from "../pipeline-authz";
import { ScpRouteError } from "./pipeline-effects";
import { loadEngagement } from "./pipeline-data";
import {
  BOOST_AUDIENCES, BOOST_STATUSES, DEFAULT_CURRENCY, MAX_MINOR, boostTotals, estimateReach, listBoosts, readBoostCandidates, readCycleMoney,
  budgetCycleFor, type BoostCandidate, type BoostRow, type BoostStatus, type ReachEstimate,
} from "./boosts-data";
import {
  boostAction, proposeBoostBudget, readBoostBudget, recordBoostBudget, requestBoost, withdrawBoostBudget,
} from "./boosts";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;
const CANDIDATES_MAX = 50;

const bad = (field: string) => new ScpRouteError(400, "invalid_field", { field });
const missing = (field: string) => new ScpRouteError(400, "missing_field", { field });

/** The opaque cursor: base64url of `<requested_at with microseconds>|<id>`. */
const encodeCursor = (k: { at: string; id: string }) => Buffer.from(`${k.at}|${k.id}`, "utf8").toString("base64url");
function decodeCursor(raw: string): { at: string; id: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [at, id] = text.split("|");
  if (!at || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(at))) throw bad("cursor");
  return { at, id };
}

const one = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A whole number from a query string, or 400. */
function queryInt(q: Record<string, unknown>, field: string, min: number, max: number): number {
  const v = one(q[field]);
  if (v === undefined) throw missing(field);
  if (!/^\d+$/.test(v)) throw bad(field);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(field);
  return n;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialBoostsController {
  // ── The monthly budget ──────────────────────────────────────────────────────────────────────────────────────────
  @Get("cycles/:cycleId/boost-budget")
  async budget(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("cycleId") cycleId: string) {
    return readBoostBudget(req.principal, tenantId, cycleId);
  }

  @Post("cycles/:cycleId/boost-budget/proposals")
  @HttpCode(201)
  async propose(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("cycleId") cycleId: string, @Body() body: unknown) {
    return proposeBoostBudget(req.principal, tenantId, cycleId, body);
  }

  @Post("boost-budget/proposals/:proposalId/withdraw")
  @HttpCode(200)
  async withdraw(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("proposalId") proposalId: string) {
    return withdrawBoostBudget(req.principal, tenantId, proposalId);
  }

  @Post("cycles/:cycleId/boost-budget/record")
  @HttpCode(201)
  async record(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("cycleId") cycleId: string, @Body() body: unknown) {
    return recordBoostBudget(req.principal, tenantId, cycleId, body);
  }

  // ── The Boosting list ───────────────────────────────────────────────────────────────────────────────────────────
  /** `{items: BoostRow[], nextCursor, candidates, totals}`. Candidates are answered on the first page only (no cursor): they are not paged. */
  @Get("boosts")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>): Promise<{
    items: BoostRow[]; nextCursor: string | null; candidates: BoostCandidate[]; totals: { committedMinor: number; spendMinor: number; currency: string };
  }> {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    const query = q ?? {};
    const status = one(query.status);
    if (status !== undefined && !(BOOST_STATUSES as readonly string[]).includes(status)) throw bad("status");
    const engagementId = one(query.engagementId);
    if (engagementId !== undefined && !UUID_RE.test(engagementId)) throw bad("engagementId");
    const cycleId = one(query.cycleId);
    if (cycleId !== undefined && !UUID_RE.test(cycleId)) throw bad("cycleId");
    const limitRaw = one(query.limit);
    let limit = PAGE_DEFAULT;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > PAGE_MAX) throw bad("limit");
      limit = Number(limitRaw);
    }
    const cursorRaw = one(query.cursor);
    const after = cursorRaw !== undefined ? decodeCursor(cursorRaw) : undefined;
    const filter = { status: status as BoostStatus | undefined, engagementId, cycleId };

    return withTenants([tenantId], async (c) => {
      const page = await listBoosts(c, tenantId, { ...filter, after, limit });
      const more = page.rows.length > limit;
      const items = page.rows.slice(0, limit);
      return {
        items,
        nextCursor: more ? encodeCursor(page.keys[limit - 1]) : null,
        candidates: after ? [] : await readBoostCandidates(c, tenantId, engagementId ?? null, CANDIDATES_MAX),
        totals: await boostTotals(c, tenantId, filter),
      };
    }, SOCIAL);
  }

  // ── The estimate ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * `{reachLow, reachHigh, basis}` for a boost of `dailyBudgetMinor × days` on the post (boosts-data.ts `estimateFrom`): `history` from the
   * client's completed boosts of the same kind (real or simulated) in the boost's currency, `simulated` for a simulated post with no such
   * history, `none` (nulls) otherwise. The currency is the post's budget cycle's for `startsOn` when given, else IDR.
   */
  @Get("posts/:postId/boosts/estimate")
  async estimate(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Query() q: Record<string, unknown>): Promise<ReachEstimate> {
    if (!UUID_RE.test(postId)) throw new ScpRouteError(404, "post_not_found");
    const authz = await withTenants([tenantId], (c) => loadSocialPostAuthz(c, tenantId, postId), SOCIAL);
    if (!authz) throw new ScpRouteError(404, "post_not_found");
    await authorize(req.principal, socialPostResource(tenantId, authz), "read");

    const query = q ?? {};
    const daily = queryInt(query, "dailyBudgetMinor", 1, MAX_MINOR);
    const days = queryInt(query, "days", 1, 90);
    if (daily * days > MAX_MINOR) throw bad("dailyBudgetMinor");
    const audience = one(query.audience);
    if (audience === undefined) throw missing("audience");
    if (!(BOOST_AUDIENCES as readonly string[]).includes(audience)) throw bad("audience");
    const startsOn = one(query.startsOn);
    if (startsOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw bad("startsOn");
    if (authz.pipelineStatus === null) throw new ScpRouteError(409, "not_a_pipeline_post");

    return withTenants([tenantId], async (c) => {
      const engagement = await loadEngagement(c, tenantId, authz.engagementId);
      if (!engagement) throw new ScpRouteError(404, "post_not_found");
      const post = await c.query<{ simulated: boolean }>(`SELECT simulated FROM social_posts WHERE tenant_id = $1 AND id = $2`, [tenantId, postId]);
      const cycleId = startsOn ? await budgetCycleFor(c, tenantId, engagement.id, startsOn) : null;
      const currency = cycleId ? (await readCycleMoney(c, tenantId, cycleId)).currency : DEFAULT_CURRENCY;
      return estimateReach(c, tenantId, { clientId: engagement.client_id, simulated: post.rows[0]?.simulated === true, currency, totalMinor: daily * days });
    }, SOCIAL);
  }

  // ── Boosts ──────────────────────────────────────────────────────────────────────────────────────────────────────
  @Post("posts/:postId/boosts")
  @HttpCode(201)
  async request(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Body() body: unknown) {
    return requestBoost(req.principal, tenantId, postId, body);
  }

  @Post("boosts/:boostId/actions")
  @HttpCode(200)
  async action(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("boostId") boostId: string, @Body() body: unknown) {
    return boostAction(req.principal, tenantId, boostId, body);
  }
}
