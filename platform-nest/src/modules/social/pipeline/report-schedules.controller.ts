// SCP-5 W5-A5 (docs/FRONTEND-BFF-CONTRACT.md §63.24.9) — report automation's routes. Thin: report-schedules.ts holds the gate, the
// validation, the job and run-as-owner; the runs are W5-A3's engine (report-runs.ts).
//
//   GET    report-schedules            {items: [Schedule]}
//   POST   report-schedules            {id?, kind, scope, engagementIds?, timing, enabled?} -> 201 {schedule, created: true}; replay 200 created: false
//   PATCH  report-schedules/:id        {scope?, engagementIds?, timing?, enabled?} -> 200 {schedule}; the caller becomes the owner
//   DELETE report-schedules/:id        200 {id, deleted: true} (soft)
//   POST   report-schedules/:id/run    "Run now" as the caller: 202 as POST reports/generate, or 200 {alreadyApplied: true, runId, period}
//
// Every route: 403 `automation_cannot_act`, 403 `not_a_social_approver` (`social_engagement` · `plan`), 404 `schedule_not_found`, 400
// `invalid_field` `{field}`, then 409 (`schedule_exists` `{scheduleId}`, `generation_running` `{runId}`, `report_kind_off`, `ai_drafting_off`).
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import {
  createReportSchedule, deleteReportSchedule, listReportSchedules, runReportScheduleNow, updateReportSchedule,
} from "./report-schedules";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialReportSchedulesController {
  @Get("report-schedules")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    return listReportSchedules(req.principal, tenantId);
  }

  @Post("report-schedules")
  async create(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string, @Body() body: unknown,
  ) {
    const r = await createReportSchedule(req.principal, tenantId, body);
    void reply.status(r.status);
    return r.body;
  }

  @Patch("report-schedules/:id")
  async update(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    return updateReportSchedule(req.principal, tenantId, id, body);
  }

  @Delete("report-schedules/:id")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    return deleteReportSchedule(req.principal, tenantId, id);
  }

  @Post("report-schedules/:id/run")
  async runNow(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string,
  ) {
    const r = await runReportScheduleNow(req.principal, tenantId, id);
    void reply.status(r.status);
    return r.body;
  }
}
