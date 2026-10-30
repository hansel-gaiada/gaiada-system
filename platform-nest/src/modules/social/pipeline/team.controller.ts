// SCP-5d — the Social Media Team dashboard's one read (BFF §63.19, PERMISSION §53.6).
//
//   GET team?month=YYYY-MM     social_engagement · plan     the four approvers' dashboard; anyone else is 403 `not_a_social_approver`
//
// THE GATE IS `plan` (`authorizePlan`, plan-authz.ts): the HoD and GM lead seats, the owner and the superadmin, with `approverIds` read from the rows.
// An unattended automation or bot is refused by the same decision (the `plan` DENY), so it never reaches a query. Authorization comes before the
// month is looked at (§63.0): a refused caller always gets 403, never 400.
//
// EACH SECTION READS ON ITS OWN. A section is one transaction (a failed statement aborts only its own), and a section that fails is named in
// `partial` and answered empty; the page reads `partial` and draws "unavailable", never an empty list (the `GET needs-you` rule). The posts the
// needs-attention, waits and workload sections share are read once.
//
// THE PRIVACY GATE (§63.19, SCP-Q19, plan §10). The team-level sections (needs attention, clients, role totals, step averages, estimates not set)
// carry no person and are the same for every reader. The two per-person lists (`workload`, `waits[].people`) are narrowed:
//   - a person in the Social Media unit or a unit under it is shown: on this read the four count as that unit's heads;
//   - anybody else (a Creatives designer, the GM's own row) is shown only if the shared DW-4 person-axis gate (`assertPersonAxisReadAllowed`, BFF
//     §44, PERMISSION §38c) lets the caller read that person, asked ONCE per distinct person. On its 403 the row is left out and `personRowsLimited`
//     is true; any other error leaves the row out too and names `personRows` in `partial`: never a silent drop.
// A row carries an id, a name and counts. No last sign-in, no e-mail, nothing else of a person.
import { BadRequestException, Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { assertPersonAxisReadAllowed } from "../../../core/person-axis-gate";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { addDays } from "../../hr/working-days";
import { todayIsoInTz } from "../../reports/person-scope";
import { isSocialSimulationEnabled } from "../publisher/simulation";
import { authorizePlan } from "./plan-authz";
import { roleHolders } from "./pipeline-data";
import {
  HEALTH_LOOKBACK_DAYS, composeCycleTable, loadCalendarInfo, readCycleTableData, readEngagements, tableAnchors,
} from "./cycles-data";
import { HOLIDAY_LOOKAHEAD_DAYS, loadWorkingCalendar } from "../../reports/dept-kpi-readers/functional/working-calendar";
import {
  FEED_WINDOW_AHEAD_DAYS, FEED_WINDOW_BEHIND_DAYS, readFeedCandidates, readFeedContext, type FeedCandidate, type FeedContext,
} from "./feed-data";
import { isMonthKey, previousMonth } from "./schedule-health";
import { readPeriodicDue } from "../report-periodic-due";
import { lateStepAttention } from "./cycle-steps-read";
import {
  TEAM_ROW_CAP, TEAM_TAG, readBoostsWaiting, readFailedPosts, readLateCycleSteps, readNames, readReportFacts, readRequestAssignees, readRosterFacts, readSimulatedPipelineIds,
  readSocialUnitPeople, readStepMoves,
} from "./team-data";
import {
  boostAttention, clientRows, composeHoldings, estimatesNotSet, failedAttention, monthRange, narrowPeople, periodicAttention, postAttention, reportAttention,
  sortAttention, stepAverages, type AttentionItem, type PostCtx, type Roster, type TeamAnswer,
} from "./team";

const SOCIAL = { modules: ["social"] };
const SOCIAL_HR = { modules: ["social", "hr"] };

function invalid(field: string, error = "invalid_field"): never {
  throw new BadRequestException({ message: error, field });
}

/** The posts the needs-attention, waits and workload sections share: one transaction, read once per request. */
interface PostsData {
  candidates: FeedCandidate[];
  ctx: FeedContext;
  simulatedIds: Set<string>;
  roster: Roster;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialTeamController {
  // ==================================================================== GET team
  @Get("team")
  async team(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>): Promise<TeamAnswer> {
    await authorizePlan(req, tenantId);

    // Validation, after the decision. A missing month is this month in the company's report zone.
    const today = todayIsoInTz(config.reportsTz);
    const raw = q.month;
    if (raw !== undefined && typeof raw !== "string") invalid("month");
    const month = raw === undefined || raw === "" ? today.slice(0, 7) : raw;
    if (!isMonthKey(month)) invalid("month");

    const principal = req.principal;
    const tz = config.reportsTz;
    // Read once, at call time: the switch decides what is counted, exactly as `GET overview` does.
    const includeSimulated = isSocialSimulationEnabled();
    const partial = new Set<string>();
    const fail = (section: string, e: unknown): void => {
      partial.add(section);
      // eslint-disable-next-line no-console
      console.error(`[scp-team] ${section} failed:`, (e as Error)?.message ?? e);
    };
    const attempt = async <T,>(section: string, empty: T, fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (e) { fail(section, e); return empty; }
    };

    // ── the shared posts read ──
    const readPosts = async (): Promise<PostsData> => {
      const copywriters = (await roleHolders(tenantId, "social_copywriter")).map((x) => x.toLowerCase());
      const inTeamDesigners = (await roleHolders(tenantId, "social_designer")).map((x) => x.toLowerCase());
      return withTenants([tenantId], async (c) => {
        const ctx = await readFeedContext(c, tenantId, { today, from: addDays(today, -FEED_WINDOW_BEHIND_DAYS), to: addDays(today, FEED_WINDOW_AHEAD_DAYS), tz });
        const candidates = await readFeedCandidates(c, tenantId, { view: "all", callerId: null, isCopywriter: false, isSeatApprover: false, isInTeamDesigner: false });
        const requestIds = [...new Set(candidates.map((x) => x.creativeRequestId).filter((x): x is string => x !== null))];
        const assigneesByRequest = await readRequestAssignees(c, tenantId, requestIds);
        const { officerIds } = await readRosterFacts(c, tenantId);
        const simulatedIds = includeSimulated ? new Set<string>() : await readSimulatedPipelineIds(c, tenantId);
        const everyone = [
          ...officerIds, ...copywriters, ...ctx.approverIds, ...inTeamDesigners, ...[...assigneesByRequest.values()].flat(),
        ];
        const names = await readNames(c, everyone);
        return {
          candidates, ctx, simulatedIds,
          roster: { officers: officerIds, copywriters, approvers: ctx.approverIds, inTeamDesigners, assigneesByRequest, names },
        };
      }, SOCIAL_HR);
    };
    let postsRead: Promise<PostsData> | null = null;
    const posts = (): Promise<PostsData> => (postsRead ??= readPosts());
    const postCtx = (d: PostsData): PostCtx => ({
      today, tz, calendar: d.ctx.calendar, samples: d.ctx.samples, includeSimulated, simulatedIds: d.simulatedIds,
    });

    // ── needs attention ──
    const attention: AttentionItem[] = [];
    try { const d = await posts(); attention.push(...postAttention(d.candidates, postCtx(d))); } catch (e) { fail("needsAttention", e); }
    try {
      const rows = await withTenants([tenantId], (c) => readFailedPosts(c, tenantId, includeSimulated), SOCIAL);
      if (rows.length > TEAM_ROW_CAP) partial.add("needsAttention");
      attention.push(...failedAttention(rows.slice(0, TEAM_ROW_CAP)));
    } catch (e) { fail("needsAttention", e); }
    try {
      const rows = await withTenants([tenantId], (c) => readBoostsWaiting(c, tenantId, includeSimulated, month), SOCIAL);
      if (rows.length > TEAM_ROW_CAP) partial.add("needsAttention");
      attention.push(...boostAttention(rows.slice(0, TEAM_ROW_CAP)));
    } catch (e) { fail("needsAttention", e); }
    // SCP-5f (§63.27.4): the month's cycles' open steps past their due date, team-level (a client, a step, a date; no person).
    try {
      const rows = await withTenants([tenantId], (c) => readLateCycleSteps(c, tenantId, month, today), SOCIAL);
      if (rows.length > TEAM_ROW_CAP) partial.add("needsAttention");
      attention.push(...lateStepAttention(rows.slice(0, TEAM_ROW_CAP)));
    } catch (e) { fail("needsAttention", e); }
    try {
      const facts = await withTenants([tenantId], (c) => readReportFacts(c, tenantId, previousMonth(month)), SOCIAL);
      if (facts.due.length > TEAM_ROW_CAP || facts.toCheck.length > TEAM_ROW_CAP) partial.add("needsAttention");
      attention.push(...reportAttention(month, { due: facts.due.slice(0, TEAM_ROW_CAP), toCheck: facts.toCheck.slice(0, TEAM_ROW_CAP) }, today));
    } catch (e) { fail("needsAttention", e); }
    // SCP-5 W5-A2 (§63.24.4): the clients' periodic reports that are due, with their `reportKind`, whatever `month`.
    try {
      const periodic = await readPeriodicDue(tenantId, { today, statuses: ["draft", "active", "paused"], mode: "after", sqlTag: TEAM_TAG });
      if (periodic.length > TEAM_ROW_CAP) partial.add("needsAttention");
      attention.push(...periodicAttention(periodic.slice(0, TEAM_ROW_CAP)));
    } catch (e) { fail("needsAttention", e); }

    // ── clients (the month's deadline table, the table `GET cycles` answers) ──
    const clients = await attempt("clients", [] as TeamAnswer["clients"], async () => {
      const data = await withTenants([tenantId], async (c) => {
        const table = await readCycleTableData(c, tenantId, month, today, tz);
        const out = includeSimulated ? new Set<string>() : await readSimulatedPipelineIds(c, tenantId);
        return { ...table, posts: table.posts.filter((p) => includeSimulated || !(p.simulated || out.has(p.id))) };
      }, SOCIAL);
      const info = await loadCalendarInfo(tenantId, tableAnchors(month, today, data.cycles), HEALTH_LOOKBACK_DAYS);
      return clientRows(composeCycleTable(data, month, today, info, false));
    });

    // ── workload and waits (the per-person lists are gated) ──
    let held = { waits: [] as TeamAnswer["waits"], workload: [] as TeamAnswer["workload"] };
    let personRowsLimited = false;
    try {
      const d = await posts();
      const all = composeHoldings(d.candidates, postCtx(d), d.roster);
      // Who is in the Social Media unit. A failed read falls back to the DW-4 gate for everybody: stricter, never wider.
      let inUnit = new Set<string>();
      try { inUnit = await withTenants([tenantId], (c) => readSocialUnitPeople(c, tenantId, today)); } catch (e) { fail("personRows", e); }
      const shown = new Set<string>();
      const denied = new Set<string>();
      const people = [...new Set([...all.workload.map((w) => w.userId), ...all.waits.flatMap((w) => w.people.map((p) => p.userId))])];
      for (const userId of people) {
        if (inUnit.has(userId)) { shown.add(userId); continue; }
        try {
          await assertPersonAxisReadAllowed(principal, tenantId, userId);
          shown.add(userId);
        } catch (e) {
          if (e instanceof ForbiddenException) denied.add(userId);
          else fail("personRows", e);
        }
      }
      const narrowed = narrowPeople(all, shown, denied);
      held = { waits: narrowed.waits, workload: narrowed.workload };
      personRowsLimited = narrowed.limited;
    } catch (e) {
      fail("workload", e);
      fail("waits", e);
      // The role totals carry no person: name the section, keep the shape.
      held = { waits: [], workload: [] };
    }

    // ── step averages (the month's stage moves, counted in the company's working days) ──
    const steps = await attempt("stepAverages", [] as TeamAnswer["stepAverages"], async () => {
      const range = monthRange(month);
      const moves = await withTenants([tenantId], (c) => readStepMoves(c, tenantId, { tz, ...range, includeSimulated }), SOCIAL);
      if (moves.length === 0) return [];
      const first = moves.reduce((m, x) => (x.enteredOn < m ? x.enteredOn : m), moves[0].enteredOn);
      const calendar = await loadWorkingCalendar(tenantId, addDays(first, -7), addDays(range.to, HOLIDAY_LOOKAHEAD_DAYS));
      return stepAverages(moves, calendar);
    });

    // ── estimates not set ──
    const notSet = await attempt("estimatesNotSet", [] as TeamAnswer["estimatesNotSet"], async () =>
      estimatesNotSet(await withTenants([tenantId], (c) => readEngagements(c, tenantId), SOCIAL)));

    const order = ["needsAttention", "clients", "workload", "waits", "stepAverages", "estimatesNotSet", "personRows"];
    return {
      month,
      needsAttention: sortAttention(attention),
      clients,
      workload: held.workload,
      waits: held.waits,
      stepAverages: steps,
      estimatesNotSet: notSet,
      personRowsLimited,
      partial: order.filter((s) => partial.has(s)),
    };
  }
}
