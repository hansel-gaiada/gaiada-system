// SCP-5 W5-A0 — the company rules' routes (FRONTEND-BFF-CONTRACT §63.30.4; PERMISSION §57). The rules core is `rules.ts`.
//
//   GET  rules                         social_post · read          {version, defaultsVersion, rules, defaults, sections, canEdit}
//   PUT  rules/:section                social_engagement · plan    {expectedVersion, value}: version + 1, the other sections unchanged
//   POST rules/:section/reset          social_engagement · plan    {expectedVersion}: version + 1 whose section is the seed's
//   GET  rules/versions?section=&cursor=&limit=   plan              the history, newest first, with each version's diff
//   POST rules/preview                 social_engagement · plan    {section, value, engagementId?}: what the unsaved value would do; saves nothing
//
// THE FOUR EDIT (SCP-Q41; `plan` is the HoD and GM lead seats, the owner, the superadmin): anyone else is 403 `not_a_social_approver`,
// decided BEFORE the body is read (BFF §63.0). The read is the team's (`social_post · read`): the pages need the rules.
// Refusals: 400 `invalid_field` `{field}` ('<section>.<path>' for a value; `section`, `expectedVersion`, `value`, `engagementId`,
// `cursor`, `limit` for the request itself); 409 `rules_changed` `{detail: {currentVersion}}` on a stale `expectedVersion`; 404
// `engagement_not_found` for a preview's unknown client. A write answers the read, and records `rules_changed` on entity
// `social_rules` (the company's id) with `{section, version, reset, diff}`.
import {
  Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize, writeActivity } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { addDays } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { loadCalendarInfo, todayIsoInTz } from "./cycles-data";
import { authorizePlan, canPlanOf } from "./plan-authz";
import {
  currentAuditPreviewer, isRulesSection, readRulesAnswer, readRulesHistory, rulesInvalid, saveRulesSectionInTx,
  validateSection, type RulesAnswer, type RulesDoc, type RulesHistoryItem, type RulesSection,
} from "./rules";
import { cycleStepDueDate, cycleStepTitle, nextReportDues, type ReportDuePreview } from "./rules-periods";
import { parseStepEstimates } from "./schedule-health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const S = { modules: ["social"] };
/** How far back a cycle step can fall from ready-by (six estimates of 30 working days, plus 30) and forward a yearly report's due day. */
const PREVIEW_WINDOW_DAYS = 400;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A body object holding only `allowed` keys, or 400 naming the first other key. */
function bodyOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObj(body)) return rulesInvalid("body");
  for (const k of Object.keys(body)) if (!allowed.includes(k)) rulesInvalid(k);
  return body;
}
function sectionOf(raw: string): RulesSection {
  if (!isRulesSection(raw)) return rulesInvalid("section");
  return raw;
}
function expectedVersionOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return rulesInvalid("expectedVersion");
  return v;
}

const encodeCursor = (beforeVersion: number): string => Buffer.from(`v${beforeVersion}`, "utf8").toString("base64url");
function decodeCursor(raw: string): number {
  const s = Buffer.from(raw, "base64url").toString("utf8");
  const m = /^v([1-9][0-9]{0,8})$/.exec(s);
  if (!m || encodeCursor(Number(m[1])) !== raw) return rulesInvalid("cursor");
  return Number(m[1]);
}

export interface RulesPreviewAnswer {
  section: RulesSection;
  engagementId: string | null;
  reports?: ReportDuePreview[];
  cycle?: { cycleId: string; month: string; readyBy: string } | null;
  steps?: Array<{ key: string; title: string; due: string | null; autoClose: string }>;
  audit?: unknown;
  /** Why a part of the preview is empty: no client was named, or the client has no cycle after this month. */
  reason?: "no_client" | "no_next_cycle";
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialRulesController {
  // ==================================================================== GET rules
  @Get("rules")
  async getRules(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<RulesAnswer> {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    const canEdit = await canPlanOf(req, tenantId);
    return withTenants([tenantId], (c) => readRulesAnswer(c, tenantId, canEdit), S);
  }

  // ==================================================================== GET rules/versions
  @Get("rules/versions")
  async getVersions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("section") sectionQ?: string, @Query("cursor") cursorQ?: string, @Query("limit") limitQ?: string,
  ): Promise<{ items: RulesHistoryItem[]; nextCursor: string | null }> {
    await authorizePlan(req, tenantId);
    const section = sectionQ === undefined || sectionQ === "" ? null : sectionOf(sectionQ);
    const beforeVersion = cursorQ === undefined || cursorQ === "" ? null : decodeCursor(cursorQ);
    let limit = 30;
    if (limitQ !== undefined && limitQ !== "") {
      if (!/^[0-9]{1,3}$/.test(limitQ) || Number(limitQ) < 1 || Number(limitQ) > 100) rulesInvalid("limit");
      limit = Number(limitQ);
    }
    const page = await withTenants([tenantId], (c) => readRulesHistory(c, tenantId, { section, beforeVersion, limit }), S);
    return { items: page.items, nextCursor: page.nextBeforeVersion === null ? null : encodeCursor(page.nextBeforeVersion) };
  }

  // ==================================================================== POST rules/preview
  @Post("rules/preview")
  async preview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown): Promise<RulesPreviewAnswer> {
    await authorizePlan(req, tenantId);
    const b = bodyOf(body, ["section", "value", "engagementId"]);
    const section = sectionOf(typeof b.section === "string" ? b.section : "");
    if (!("value" in b)) rulesInvalid("value");
    const value = validateSection(section, b.value);
    let engagementId: string | null = null;
    if (b.engagementId !== undefined && b.engagementId !== null) {
      if (typeof b.engagementId !== "string" || !UUID_RE.test(b.engagementId)) rulesInvalid("engagementId");
      engagementId = (b.engagementId as string).toLowerCase();
    }
    const today = todayIsoInTz(config.reportsTz);
    const eng = engagementId === null ? null : await withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      const e = await c.query<{ report_due_day: number | null; step_estimates: unknown }>(
        `SELECT report_due_day, step_estimates FROM social_engagements WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [tenantId, engagementId],
      );
      if (!e.rows[0]) throw new NotFoundException({ message: "engagement_not_found" });
      const cy = await c.query<{ id: string; month: string; ready_by: string }>(
        `SELECT id, to_char(month, 'YYYY-MM') AS month, to_char(ready_by, 'YYYY-MM-DD') AS ready_by
           FROM social_cycles
          WHERE tenant_id = $1 AND engagement_id = $2 AND deleted_at IS NULL AND month > date_trunc('month', $3::date)::date
          ORDER BY month LIMIT 1`,
        [tenantId, engagementId, today],
      );
      const r = e.rows[0];
      return {
        reportDueDay: r.report_due_day === null ? null : Number(r.report_due_day),
        estimates: parseStepEstimates(r.step_estimates),
        nextCycle: cy.rows[0] ? { cycleId: cy.rows[0].id, month: cy.rows[0].month, readyBy: cy.rows[0].ready_by } : null,
      };
    }, S);

    const out: RulesPreviewAnswer = { section, engagementId };
    if (section === "reports") {
      const { calendar } = await loadCalendarInfo(tenantId, [today, addDays(today, PREVIEW_WINDOW_DAYS)], PREVIEW_WINDOW_DAYS);
      out.reports = nextReportDues(value as RulesDoc["reports"], today, { reportDueDay: eng?.reportDueDay ?? null, calendar });
      if (!eng) out.reason = "no_client";
    } else if (section === "cycle") {
      const steps = (value as RulesDoc["cycle"]).steps;
      if (!eng) {
        out.cycle = null;
        out.steps = [];
        out.reason = "no_client";
      } else if (!eng.nextCycle) {
        out.cycle = null;
        out.steps = [];
        out.reason = "no_next_cycle";
      } else {
        const nc = eng.nextCycle;
        const { calendar } = await loadCalendarInfo(tenantId, [nc.readyBy], PREVIEW_WINDOW_DAYS);
        out.cycle = nc;
        out.steps = steps.map((s) => ({
          key: s.key,
          title: cycleStepTitle(s, nc.month),
          due: cycleStepDueDate(s, nc.month, { readyBy: nc.readyBy, estimates: eng.estimates, reportDueDay: eng.reportDueDay, calendar }),
          autoClose: s.autoClose.rule,
        }));
      }
    } else if (section === "audit") {
      const previewer = currentAuditPreviewer();
      out.audit = previewer && engagementId ? await previewer({ tenantId, engagementId, scorecard: value as RulesDoc["audit"] }) : null;
      if (!engagementId) out.reason = "no_client";
    }
    return out;
  }

  // ==================================================================== PUT rules/:section
  @Put("rules/:section")
  async putSection(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("section") sectionP: string, @Body() body: unknown,
  ): Promise<RulesAnswer> {
    await authorizePlan(req, tenantId);
    const section = sectionOf(sectionP);
    const b = bodyOf(body, ["expectedVersion", "value"]);
    const expectedVersion = expectedVersionOf(b.expectedVersion);
    if (!("value" in b)) rulesInvalid("value");
    const value = validateSection(section, b.value);
    return this.save(req, tenantId, { section, expectedVersion, value, reset: false });
  }

  // ==================================================================== POST rules/:section/reset
  @Post("rules/:section/reset")
  async resetSection(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("section") sectionP: string, @Body() body: unknown,
  ): Promise<RulesAnswer> {
    await authorizePlan(req, tenantId);
    const section = sectionOf(sectionP);
    const b = bodyOf(body, ["expectedVersion"]);
    return this.save(req, tenantId, { section, expectedVersion: expectedVersionOf(b.expectedVersion), reset: true });
  }

  private async save(
    req: FastifyRequest, tenantId: string, a: { section: RulesSection; expectedVersion: number; value?: unknown; reset: boolean },
  ): Promise<RulesAnswer> {
    const actorId = req.principal.userId;
    // `plan` is only ever a person's (the automation DENY, PERMISSION §53.3); a version always names who saved it.
    if (!actorId) throw new ForbiddenException({ message: "not_a_social_approver" });
    const { answer, saved } = await withTenants([tenantId], async (c) => {
      const saved = await saveRulesSectionInTx(c, { tenantId, actorId, ...a });
      return { saved, answer: await readRulesAnswer(c, tenantId, true) };
    }, S);
    await writeActivity(tenantId, actorId, "rules_changed", "social_rules", tenantId, {
      section: a.section, version: saved.version, reset: a.reset, diff: saved.diff,
    });
    return answer;
  }
}
