// SCP-5 W5-A3 (docs/FRONTEND-BFF-CONTRACT.md §63.24.5) — the "Generate with AI" routes: start a run for every client the caller may draft
// for, read its progress, list the recent runs. Thin: report-runs.ts holds the run and its rules. One client is the create route
// (`POST engagements/:engagementId/reports`, social-reports.controller.ts), answered in the request.
//
// Its own controller class on the module's prefix (Nest admits several as long as no path collides): `reports/generate` is a static
// segment, which the router matches before `reports/:id`.
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { listReportRuns, readReportRun, startReportRun, type StartRunBody } from "./report-runs";

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialReportRunsController {
  /** `{id?, kind, period, engagementIds?}` -> 202 `{runId, kind, period, total, clients}`; a replayed `id` 200 with the run as it stands. */
  @Post("reports/generate")
  async generate(
    @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("tenantId") tenantId: string,
    @Body() body: StartRunBody = {},
  ) {
    const r = await startReportRun(req.principal, tenantId, body ?? {});
    void reply.status(r.status);
    return r.body;
  }

  @Get("reports/generate")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("scheduleId") scheduleId?: string) {
    return listReportRuns(req.principal, tenantId, scheduleId);
  }

  @Get("reports/generate/:runId")
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    return readReportRun(req.principal, tenantId, runId);
  }
}
