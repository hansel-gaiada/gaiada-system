// M5-V5-c — A/B tests on blocks: the BFF routes (and the MCP tools bound to them, experiments-mcp-tools.ts).
//   GET   /api/:tenantId/modules/search/properties/:propertyId/experiments[?status=all|draft|running|stopped|aborted|decided]   (read)
//   POST  .../experiments                              register = the PRE-REGISTRATION            (update; 201)
//   GET   .../experiments/:experimentId                the record and its pre-registration        (read)
//   PATCH .../experiments/:experimentId                edit a DRAFT; after start 409 pre_registration_locked   (update)
//   POST  .../experiments/:experimentId/sync           detect "running" from WebDesk              (update)
//   GET   .../experiments/:experimentId/results        progress + SRM before the horizon; the analysis at it (read)
//   POST  .../experiments/:experimentId/stop           only at the horizon; before it use abort   (update)
//   POST  .../experiments/:experimentId/abort          any time before the decision; no outcome   (update)
//   POST  .../experiments/:experimentId/decide         record the decision once the block is gone (update)
// Cerbos: the EXISTING `resource_search_property` kind, `read` for the reads and `update` for every write (design §5.5: no new
// action, no policy change). Every public change still goes through WebDesk's content grants and the WS4 publish approval:
// nothing here writes to WebDesk or Umami, so each write is LOW impact. Rows are reached through
// withTenants([tenantId], {modules:['search']}), so another company's property or experiment is 404 and a principal outside the
// tenant is refused at authorize (403). Authorization runs BEFORE any body validation, so a denial never depends on the body.
//
// Typed refusals carry their token first in `error` and in `reason` (the error filter forwards `reason`); `underpowered` also
// carries the projection in `existing` ({projectedDays, maxDays, nPerArm, dailyUnits}).
//
// A separate controller class on SearchController's prefix (same reason as search-analytics.controller.ts).
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { ExperimentRefusal, parseDraftPatch, parseNote, parseRegistration } from "./experiments";
import {
  EXPERIMENT_STATUSES, abortExperiment, decideExperiment, experimentIo, getExperiment, listExperiments, readResults, refusalToHttp,
  registerExperiment, stopExperiment, syncExperiment, updateDraft, type ExperimentDto, type ExperimentResults,
} from "./experiments.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run a service call; a typed refusal becomes its HTTP error (token first in the message), anything else propagates. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExperimentRefusal) throw refusalToHttp(e);
    throw e;
  }
}
function refuseBody(p: { token: string; message: string }): never {
  throw refusalToHttp(new ExperimentRefusal(400, p.token, p.message));
}

@Controller("api/:tenantId/modules/search")
@UseGuards(AuthGuard, ModuleEnabledGuard("search"))
export class SearchExperimentsController {
  private async gate(req: FastifyRequest, tenantId: string, propertyId: string, action: "read" | "update"): Promise<void> {
    if (!UUID_RE.test(propertyId)) throw new BadRequestException("propertyId must be a valid id");
    await authorize(req.principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, action);
  }
  private static expId(experimentId: string): void {
    if (!UUID_RE.test(experimentId)) throw new BadRequestException("experimentId must be a valid id");
  }

  @Get("properties/:propertyId/experiments")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Query("status") status?: string,
  ): Promise<{ propertyId: string; experiments: ExperimentDto[] }> {
    await this.gate(req, tenantId, propertyId, "read");
    if (status !== undefined && status !== "all" && !(EXPERIMENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException("status must be all, draft, running, stopped, aborted or decided");
    }
    const experiments = await listExperiments(tenantId, propertyId, status);
    if (!experiments) throw new NotFoundException("property not found");
    return { propertyId, experiments };
  }

  @Post("properties/:propertyId/experiments")
  async register(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Body() body: unknown,
  ): Promise<{ experiment: ExperimentDto }> {
    await this.gate(req, tenantId, propertyId, "update");
    const parsed = parseRegistration(body, { allowAllEnrolment: experimentIo.allowAllEnrolment() });
    if (!parsed.ok) refuseBody(parsed);
    const userId = req.principal.userId ?? null;
    const out = await guarded(() => registerExperiment(tenantId, propertyId, parsed.value, userId));
    if (out === "no_property") throw new NotFoundException("property not found");
    await writeActivity(tenantId, userId, "experiment_registered", "search_experiment", out.id, {
      propertyId, key: out.key, nPerArm: out.preRegistration.nPerArm, projectedDays: out.preRegistration.projectedDays,
    });
    return { experiment: out };
  }

  @Get("properties/:propertyId/experiments/:experimentId")
  async get(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
  ): Promise<{ experiment: ExperimentDto }> {
    await this.gate(req, tenantId, propertyId, "read");
    SearchExperimentsController.expId(experimentId);
    const experiment = await getExperiment(tenantId, propertyId, experimentId);
    if (!experiment) throw new NotFoundException("experiment not found");
    return { experiment };
  }

  @Patch("properties/:propertyId/experiments/:experimentId")
  async edit(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
    @Body() body: unknown,
  ): Promise<{ experiment: ExperimentDto }> {
    await this.gate(req, tenantId, propertyId, "update");
    SearchExperimentsController.expId(experimentId);
    const parsed = parseDraftPatch(body, { allowAllEnrolment: experimentIo.allowAllEnrolment() });
    if (!parsed.ok) refuseBody(parsed);
    const out = await guarded(() => updateDraft(tenantId, propertyId, experimentId, parsed.value));
    if (out === "no_property") throw new NotFoundException("property not found");
    if (out === "not_found") throw new NotFoundException("experiment not found");
    await writeActivity(tenantId, req.principal.userId ?? null, "experiment_edited", "search_experiment", out.id, { propertyId, fields: Object.keys(parsed.value) });
    return { experiment: out };
  }

  @Post("properties/:propertyId/experiments/:experimentId/sync")
  @HttpCode(200)
  async sync(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
  ) {
    await this.gate(req, tenantId, propertyId, "update");
    SearchExperimentsController.expId(experimentId);
    const out = await guarded(() => syncExperiment(tenantId, propertyId, experimentId));
    if (out === "no_property") throw new NotFoundException("property not found");
    if (out === "not_found") throw new NotFoundException("experiment not found");
    if (out.state === "started") {
      await writeActivity(tenantId, req.principal.userId ?? null, "experiment_started", "search_experiment", out.experiment.id, { propertyId, key: out.experiment.key });
    }
    return out;
  }

  @Get("properties/:propertyId/experiments/:experimentId/results")
  async results(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
  ): Promise<ExperimentResults> {
    await this.gate(req, tenantId, propertyId, "read");
    SearchExperimentsController.expId(experimentId);
    const out = await guarded(() => readResults(tenantId, propertyId, experimentId));
    if (out === "not_found") throw new NotFoundException("experiment not found");
    return out;
  }

  @Post("properties/:propertyId/experiments/:experimentId/stop")
  @HttpCode(200)
  async stop(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
  ) {
    await this.gate(req, tenantId, propertyId, "update");
    SearchExperimentsController.expId(experimentId);
    const out = await guarded(() => stopExperiment(tenantId, propertyId, experimentId));
    if (out === "no_property") throw new NotFoundException("property not found");
    if (out === "not_found") throw new NotFoundException("experiment not found");
    if (!out.replayed) await writeActivity(tenantId, req.principal.userId ?? null, "experiment_stopped", "search_experiment", out.experiment.id, { propertyId, key: out.experiment.key });
    return out;
  }

  @Post("properties/:propertyId/experiments/:experimentId/abort")
  @HttpCode(200)
  async abort(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
  ) {
    await this.gate(req, tenantId, propertyId, "update");
    SearchExperimentsController.expId(experimentId);
    const userId = req.principal.userId ?? null;
    const out = await guarded(() => abortExperiment(tenantId, propertyId, experimentId, userId));
    if (out === "no_property") throw new NotFoundException("property not found");
    if (out === "not_found") throw new NotFoundException("experiment not found");
    if (!out.replayed) await writeActivity(tenantId, userId, "experiment_aborted", "search_experiment", out.experiment.id, { propertyId, key: out.experiment.key });
    return out;
  }

  @Post("properties/:propertyId/experiments/:experimentId/decide")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("propertyId") propertyId: string, @Param("experimentId") experimentId: string,
    @Body() body: unknown,
  ) {
    await this.gate(req, tenantId, propertyId, "update");
    SearchExperimentsController.expId(experimentId);
    const note = parseNote(body);
    if (!note.ok) refuseBody(note);
    const userId = req.principal.userId ?? null;
    const out = await guarded(() => decideExperiment(tenantId, propertyId, experimentId, note.value, userId));
    if (out === "no_property") throw new NotFoundException("property not found");
    if (out === "not_found") throw new NotFoundException("experiment not found");
    if (!out.replayed) await writeActivity(tenantId, userId, "experiment_decided", "search_experiment", out.experiment.id, { propertyId, key: out.experiment.key });
    return out;
  }
}
