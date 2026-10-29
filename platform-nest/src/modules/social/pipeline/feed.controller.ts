// SCP-1d / SCP-1j — the Social feed, Messages and the pipeline's leg of "Needs you" (BFF §63.7).
//
//   GET feed?view=your_turn|waiting|all&engagementId=&cycleId=&phase=&officerId=&cursor=&limit=   social_post · read   PipelineCard items
//   GET waiting                                                                                    social_post · read   Messages: who holds my posts
//   GET needs-you                                                                                  social_post · read   the pipeline's leg of lib/queue.ts
//                                                                                                  (SCP-4a: + the seats' boosts approved, not started)
//                                                                                                  (SCP-5a: + the officer's monthly reports due, the seats'
//                                                                                                   reports to check and to send)
//   GET overview                                                                                   social_post · read   the Overview's Pulse tiles (SCP-3f)
//
// AUTHORIZATION BEFORE VALIDATION (BFF §63.0): the read decision is asked first, so a refused caller always gets 403, never a 400.
// What each caller SEES is narrowed by relationship facts read from the rows (the officer is the engagement's owner, a Creatives designer an
// assignee of the month request's PM task, the approvers the two lead seats), never from a query value; `officerId` and the other filters only
// narrow further. The module wall: every query declares `{ modules: ["social", "hr"] }` (hr for the one holiday read the health maths needs).
//
// THE BAR (§63.7, SCP-1d): at most three SQL queries and two Cerbos calls a page (`feed-data.ts` names them). The two Cerbos calls are
// `authorize(read)` and ONE `checkEach` over the page (at most 50 posts, each asked the action its primary step needs). A page is therefore
// at most 50 cards even though `limit` allows 100: a second request is the cursor's job.
import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize } from "../../../core/http";
import { checkEach } from "../../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../../rbac/principal";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { addDays } from "../../hr/working-days";
import { grantCoversTenant, todayIsoInTz } from "../../reports/person-scope";
import { loadSocialApproverIds } from "../pipeline-authz";
import { isSocialSimulationEnabled } from "../publisher/simulation";
import { findDepartmentBySlug, roleHolders } from "./pipeline-data";
import { readBoostsToStart } from "./boosts-data";
import { readReportsDue, readReportsToAct } from "../report-data";
import { monthLabel, previousPeriod, reportDueDate } from "../reports";
import { HOLDER_LABELS } from "./pipeline-read";
import {
  FEED_WINDOW_AHEAD_DAYS, FEED_WINDOW_BEHIND_DAYS, readFeedCandidates, readFeedContext, readFeedPageExtras, readLastFollowUps, readMetricsMissing,
  type FeedCandidate, type FeedPageExtras,
} from "./feed-data";
import { readOverviewFacts } from "./overview-data";
import { composeOverview, weekOf, type OverviewAnswer } from "./overview";
import {
  FEED_PAGE_DEFAULT, FEED_PAGE_MAX, FEED_PHASES, cardOf, cerbosActionsFor, composeEntries, decodeCursor, holderRoleOf, isWaitingOn, isYourTurn, needsYouKind,
  nextActionOf, pageOf, primaryRouteAction, resourceOfCandidate, type FeedCaller, type PipelineCard,
} from "./feed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOCIAL_HR = { modules: ["social", "hr"] };
const SOCIAL = { modules: ["social"] };
const NEEDS_YOU_MAX = 50;

function invalid(field: string, error = "invalid_field"): never {
  throw new BadRequestException({ message: error, field });
}

/** The read every team member with a social read tier holds: `social_post` · `read`. Runs before anything in the query is looked at. */
async function authorizeRead(req: FastifyRequest, tenantId: string): Promise<void> {
  await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
}

/** What the principal's own grants say about the caller (the derived roles' own conditions); the seat is read from the rows by the caller. */
function callerOf(principal: Principal, tenantId: string, isSeatApprover: boolean): FeedCaller {
  const holds = (role: string) => principal.roles.some((g) => g.role === role && grantCoversTenant(g, tenantId));
  return {
    userId: principal.userId ? principal.userId.toLowerCase() : null,
    isCopywriter: holds("social_copywriter"), isSeatApprover, isInTeamDesigner: holds("social_designer"),
  };
}

/** One value of a query parameter: a repeated parameter is not one. */
function single(q: Record<string, unknown>, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") invalid(name);
  return v;
}

function uuidParam(q: Record<string, unknown>, name: string): string | undefined {
  const v = single(q, name);
  if (v === undefined || v === "") return undefined;
  if (!UUID_RE.test(v)) invalid(name);
  return v.toLowerCase();
}

/**
 * Cerbos's answers for each item, as `authorize()` would reach them: the caller, and (a delegated call) the person it acts for as well; either
 * denial denies. ONE request for the caller; a delegated call adds one for the person it acts for. Advisory: the action route decides again.
 */
async function decisionsFor(principal: Principal, items: Array<{ resource: ReturnType<typeof resourceOfCandidate>; actions: string[] }>): Promise<Array<Record<string, boolean>>> {
  if (items.length === 0) return [];
  const mine = await checkEach(principal, items);
  if (!principal.actFor || principal.actFor.userId === principal.userId) return mine;
  const theirs = await assemblePrincipal(principal.actFor.userId, principal.assurance);
  if (!theirs) return mine.map((m) => Object.fromEntries(Object.keys(m).map((a) => [a, false])));
  const other = await checkEach({ ...theirs, via: principal.via }, items);
  return mine.map((m, i) => Object.fromEntries(Object.keys(m).map((a) => [a, m[a] === true && other[i]?.[a] === true])));
}

interface WaitingPost {
  id: string; title: string; clientName: string; since: string; lastFollowUpAt: string | null;
  /** Additive to §63.7 (the Follow up button posts `expectedStatus`, and the client's thread is found by the client). */
  pipelineStatus: string; engagementId: string; clientId: string;
}
interface WaitingGroup { holder: { role: string; label: string; userIds: string[] }; posts: WaitingPost[] }

/** The order groups are listed in: the people the officer waits on most often first, the client and anyone outside last. */
const GROUP_ORDER = ["approver", "copywriter", "designer", "client", "external"];

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialFeedController {
  // ==================================================================== GET feed
  @Get("feed")
  async feed(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>): Promise<{ items: PipelineCard[]; nextCursor: string | null }> {
    await authorizeRead(req, tenantId);

    // Validation, after the decision.
    const viewRaw = single(q, "view") ?? "your_turn";
    if (viewRaw !== "your_turn" && viewRaw !== "waiting" && viewRaw !== "all") invalid("view");
    const view = viewRaw;
    const engagementId = uuidParam(q, "engagementId");
    const cycleId = uuidParam(q, "cycleId");
    const officerId = uuidParam(q, "officerId");
    const phase = single(q, "phase");
    if (phase !== undefined && phase !== "" && !FEED_PHASES.includes(phase)) invalid("phase");
    const limitRaw = single(q, "limit");
    let limit = FEED_PAGE_DEFAULT;
    if (limitRaw !== undefined && limitRaw !== "") {
      if (!/^\d+$/.test(limitRaw)) invalid("limit");
      limit = Number(limitRaw);
      if (limit < 1 || limit > 100) invalid("limit");
    }
    const cursorRaw = single(q, "cursor");
    const cursor = cursorRaw === undefined || cursorRaw === "" ? null : decodeCursor(cursorRaw);
    if (cursorRaw !== undefined && cursorRaw !== "" && cursor === null) invalid("cursor");
    const size = Math.min(limit, FEED_PAGE_MAX);

    const principal = req.principal;
    const today = todayIsoInTz(config.reportsTz);
    const data = await withTenants([tenantId], async (c) => {
      // Q1: the seats, the holidays and the client's recent decisions.
      const ctx = await readFeedContext(c, tenantId, { today, from: addDays(today, -FEED_WINDOW_BEHIND_DAYS), to: addDays(today, FEED_WINDOW_AHEAD_DAYS), tz: config.reportsTz });
      const who = callerOf(principal, tenantId, !!principal.userId && ctx.approverIds.includes(principal.userId.toLowerCase()));
      // Q2: the narrowed posts.
      const candidates = await readFeedCandidates(c, tenantId, {
        view, callerId: who.userId, isCopywriter: who.isCopywriter, isSeatApprover: who.isSeatApprover, isInTeamDesigner: who.isInTeamDesigner,
        engagementId, cycleId, officerId,
      });
      const entries = composeEntries(candidates, who, { view, phase: phase === "" ? undefined : phase }, { today, calendar: ctx.calendar, samples: ctx.samples });
      const { page, nextCursor } = pageOf(entries, cursor, size);
      // Q3: the page's thumbnails and the month requests' assignees.
      const requestIds = [...new Set(page.map((e) => e.c.creativeRequestId).filter((x): x is string => x !== null))];
      const extras = await readFeedPageExtras(c, tenantId, page.map((e) => e.c.id), requestIds);
      return { ctx, page, nextCursor, extras };
    }, SOCIAL_HR);

    // The second Cerbos call: the page's primary steps, one request.
    const actions = data.page.map((e) => primaryRouteAction(e.c));
    const asked: Array<{ index: number; resource: ReturnType<typeof resourceOfCandidate>; actions: string[] }> = [];
    data.page.forEach((e, index) => {
      const a = actions[index];
      if (a === null) return;
      const names = cerbosActionsFor(e.c, a);
      if (names.length === 0) return;
      asked.push({ index, resource: resourceOfCandidate(tenantId, e.c, data.ctx.approverIds, e.c.creativeRequestId ? data.extras.assignees.get(e.c.creativeRequestId) ?? [] : []), actions: names });
    });
    const decided = await decisionsFor(principal, asked);
    const decisionOf = new Map(asked.map((a, i) => [a.index, decided[i] ?? {}]));
    const isAutomation = principal.kind === "automation" || principal.kind === "bot";
    const items = data.page.map((e, index) =>
      cardOf(e, data.extras.thumbs.get(e.c.id) ?? null, nextActionOf(e.c, actions[index], decisionOf.get(index) ?? {}, { userId: principal.userId ? principal.userId.toLowerCase() : null, isAutomation })));
    return { items, nextCursor: data.nextCursor };
  }

  // ==================================================================== GET overview
  /**
   * The Overview's Pulse tiles (§63.7). Authorization first; there is nothing to validate. The caller's view is the feed's `all` (the whole company's
   * pipeline: the tiles are the team's, narrowed by nothing a query could name). Three statements (`overview-data.ts`), the same module wall as the feed.
   */
  @Get("overview")
  async overview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<OverviewAnswer> {
    await authorizeRead(req, tenantId);
    // Read once, at call time: the switch decides both what is counted and what the answer says.
    const includeSimulated = isSocialSimulationEnabled();
    const today = todayIsoInTz(config.reportsTz);
    return withTenants([tenantId], async (c) => {
      const ctx = await readFeedContext(c, tenantId, { today, from: addDays(today, -FEED_WINDOW_BEHIND_DAYS), to: addDays(today, FEED_WINDOW_AHEAD_DAYS), tz: config.reportsTz });
      const candidates = await readFeedCandidates(c, tenantId, {
        view: "all", callerId: null, isCopywriter: false, isSeatApprover: false, isInTeamDesigner: false,
      });
      const facts = await readOverviewFacts(c, tenantId, { tz: config.reportsTz, week: weekOf(today), includeSimulated });
      return composeOverview(candidates, facts, { today, calendar: ctx.calendar, samples: ctx.samples, includeSimulated });
    }, SOCIAL_HR);
  }

  // ==================================================================== GET waiting
  @Get("waiting")
  async waiting(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<{ groups: WaitingGroup[] }> {
    await authorizeRead(req, tenantId);
    const me = req.principal.userId ? req.principal.userId.toLowerCase() : null;
    if (!me) return { groups: [] };

    const data = await withTenants([tenantId], async (c) => {
      const approverIds = await loadSocialApproverIds(c, tenantId);
      const candidates = await readFeedCandidates(c, tenantId, {
        view: "waiting", callerId: me, isCopywriter: false, isSeatApprover: false, isInTeamDesigner: false,
      });
      const held = candidates.map((x) => ({ c: x, holder: holderRoleOf(x) })).filter((x) => x.c.ownerId === me && isWaitingOn(x.holder));
      const ids = held.map((x) => x.c.id);
      const lastFollowUps = await readLastFollowUps(c, tenantId, ids);
      const requestIds = [...new Set(held.filter((x) => x.holder === "designer").map((x) => x.c.creativeRequestId).filter((x): x is string => x !== null))];
      const extras: FeedPageExtras = await readFeedPageExtras(c, tenantId, ids, requestIds);
      return { approverIds, held, lastFollowUps, extras };
    }, SOCIAL);

    const roles = [...new Set(data.held.map((x) => x.holder as string))];
    const copywriters = roles.includes("copywriter") ? await roleHolders(tenantId, "social_copywriter") : [];
    const inTeamDesigners = data.held.some((x) => x.holder === "designer" && x.c.creativeSource === "in_team") ? await roleHolders(tenantId, "social_designer") : [];

    const groups: WaitingGroup[] = [];
    for (const role of [...GROUP_ORDER.filter((r) => roles.includes(r)), ...roles.filter((r) => !GROUP_ORDER.includes(r)).sort()]) {
      const members = data.held.filter((x) => x.holder === role).sort((a, b) => (a.c.statusSince < b.c.statusSince ? -1 : a.c.statusSince > b.c.statusSince ? 1 : a.c.id < b.c.id ? -1 : 1));
      const userIds =
        role === "approver" ? data.approverIds
        : role === "copywriter" ? copywriters
        : role === "designer"
          ? [...new Set([
              ...inTeamDesigners,
              ...members.flatMap((m) => (m.c.creativeSource === "creatives" && m.c.creativeRequestId ? data.extras.assignees.get(m.c.creativeRequestId) ?? [] : [])),
            ])]
        : [];
      groups.push({
        holder: { role, label: HOLDER_LABELS[role] ?? role, userIds },
        posts: members.map((m) => ({
          id: m.c.id, title: m.c.title, clientName: m.c.clientName, since: m.c.statusSince,
          lastFollowUpAt: data.lastFollowUps.get(`${m.c.id}|${role}`) ?? null,
          pipelineStatus: m.c.pipelineStatus, engagementId: m.c.engagementId, clientId: m.c.clientId,
        })),
      });
    }
    return { groups };
  }

  // ==================================================================== GET needs-you
  @Get("needs-you")
  async needsYou(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorizeRead(req, tenantId);
    const principal = req.principal;
    const me = principal.userId ? principal.userId.toLowerCase() : null;
    const partial: string[] = [];
    if (!me) return { items: [] as NeedsYouItem[], partial };

    const items: NeedsYouItem[] = [];
    let href = (postId: string) => `/departments/${postId}`;
    // Source 1: the posts that are the caller's turn, by role (the same facts the feed's `your_turn` reads).
    try {
      const data = await withTenants([tenantId], async (c) => {
        const approverIds = await loadSocialApproverIds(c, tenantId);
        const who = callerOf(principal, tenantId, approverIds.includes(me));
        const candidates = await readFeedCandidates(c, tenantId, {
          view: "your_turn", callerId: me, isCopywriter: who.isCopywriter, isSeatApprover: who.isSeatApprover, isInTeamDesigner: who.isInTeamDesigner,
        });
        const dept = await findDepartmentBySlug(c, tenantId, "social-media");
        return { who, candidates, dept };
      }, SOCIAL);
      const base = data.dept ? `/departments/${data.dept.id}/posts/` : "/departments#";
      href = (postId) => `${base}${postId}`;
      for (const cand of data.candidates) {
        const holder = holderRoleOf(cand);
        const k = needsYouKind(cand.pipelineStatus, holder);
        if (!k) continue;
        // The facts the feed uses decide whose turn it is; `needsYouKind` only names what kind of work it is.
        if (!isYourTurn(cand, holder, data.who)) continue;
        const due = k.kind === "ready_to_schedule" ? cand.scheduledAt?.slice(0, 10) ?? null : cand.readyBy;
        items.push({
          id: `social:${tenantId}:${cand.id}:${k.kind}`, kind: k.kind, role: k.role, title: cand.title, clientName: cand.clientName,
          since: cand.statusSince, ...(due ? { due } : {}), href: href(cand.id),
        });
      }
    } catch {
      partial.push("pipeline posts");
    }
    // Source 2: the officer's live posts still without metrics two days on.
    try {
      const rows = await withTenants([tenantId], (c) => readMetricsMissing(c, tenantId, me), SOCIAL);
      for (const r of rows) {
        items.push({ id: `social:${tenantId}:${r.id}:metrics_missing`, kind: "metrics_missing", role: "officer", title: r.title, clientName: r.clientName, since: r.wentLiveAt, href: href(r.id) });
      }
    } catch {
      partial.push("post metrics");
    }
    // Source 3 (SCP-4a, §63.7): for the HoD and GM seats, boosts approved but not started (every client's: the seats run the team's boosts).
    try {
      const data = await withTenants([tenantId], async (c) => {
        const approverIds = await loadSocialApproverIds(c, tenantId);
        if (!approverIds.includes(me)) return null;
        const dept = await findDepartmentBySlug(c, tenantId, "social-media");
        return { dept, rows: await readBoostsToStart(c, tenantId, NEEDS_YOU_MAX) };
      }, SOCIAL);
      if (data) {
        const base = data.dept ? `/departments/${data.dept.id}/posts/` : "/departments#";
        for (const r of data.rows) {
          items.push({
            id: `social:${tenantId}:${r.id}:boost_start`, kind: "boost_start", role: "approver", title: r.title, clientName: r.clientName,
            since: r.since, due: r.startsOn, href: `${base}${r.postId}`,
          });
        }
      }
    } catch {
      partial.push("boosts");
    }
    // Source 4 (SCP-5a, §63.7, §63.18 "Reports due"): the officer's monthly reports due. An engagement with a `report_due_day`
    // has its report for last month (M-1) due on that day of this month (M), clamped to the month's end, until a monthly report
    // for M-1 is delivered; the item shows whether or not the report row exists yet (it opens the report, or the list).
    // "This month" is the company's report day (REPORTS_TZ, UTC when unset), as every day count of the pipeline.
    try {
      const today = todayIsoInTz(config.reportsTz);
      const period = previousPeriod(today);
      const data = await withTenants([tenantId], async (c) => ({
        rows: await readReportsDue(c, tenantId, me, period),
        dept: await findDepartmentBySlug(c, tenantId, "social-media"),
      }), SOCIAL);
      const base = data.dept ? `/departments/${data.dept.id}/social-reports` : "/departments#";
      for (const r of data.rows) {
        const due = reportDueDate(period, r.reportDueDay);
        items.push({
          id: `social:${tenantId}:${r.reportId ?? r.engagementId}:report_due`, kind: "report_due", role: "officer",
          title: `Monthly report, ${monthLabel(period)}`, clientName: r.clientName,
          since: `${today.slice(0, 7)}-01T00:00:00.000Z`, ...(due ? { due } : {}),
          href: r.reportId && data.dept ? `${base}/${r.reportId}` : base,
        });
      }
    } catch {
      partial.push("reports due");
    }
    // Source 5 (SCP-5a, §63.7): for the HoD and GM seats, every client's reports in the HoD check (`report_check`) and ready to
    // send (`report_send`). The owner and the superadmin act from the same pages but get no queue.
    try {
      const data = await withTenants([tenantId], async (c) => {
        const approverIds = await loadSocialApproverIds(c, tenantId);
        if (!approverIds.includes(me)) return null;
        const dept = await findDepartmentBySlug(c, tenantId, "social-media");
        return { dept, rows: await readReportsToAct(c, tenantId, NEEDS_YOU_MAX) };
      }, SOCIAL);
      if (data) {
        const base = data.dept ? `/departments/${data.dept.id}/social-reports` : "/departments#";
        for (const r of data.rows) {
          const due = r.kind === "monthly" && r.period && r.reportDueDay !== null ? reportDueDate(r.period, r.reportDueDay) : null;
          const what = r.kind === "monthly" ? "Monthly report" : r.kind === "campaign" ? "Campaign report" : "Report";
          items.push({
            id: `social:${tenantId}:${r.id}:${r.status === "in_review" ? "report_check" : "report_send"}`,
            kind: r.status === "in_review" ? "report_check" : "report_send", role: "approver",
            title: r.period ? `${what}, ${monthLabel(r.period)}` : what, clientName: r.clientName, since: r.since,
            ...(due ? { due } : {}), href: data.dept ? `${base}/${r.id}` : base,
          });
        }
      }
    } catch {
      partial.push("reports");
    }
    items.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { items: items.slice(0, NEEDS_YOU_MAX), partial };
  }
}

export interface NeedsYouItem {
  id: string; kind: string; role: string; title: string; clientName: string; since: string; due?: string; href: string;
}

