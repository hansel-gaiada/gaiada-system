// SCP-1b — the Social Media content pipeline's post routes (FRONTEND-BFF-CONTRACT §63.6.1 to §63.6.7). Mounted under
// `api/:tenantId/modules/social`, behind AuthGuard and ModuleEnabledGuard("social"), beside SocialController (whose route
// prefix it shares; no path here collides with one of its paths).
//
// Routes only. Every write runs one orchestration (pipeline.service.ts: the rows, Cerbos once, the machine's gate, one
// locked transaction, then activity and notifications), and every answer carries the post as `GET …/pipeline` reads it.
// The machine is the fixture (`scp-stage-machine.json`); nothing here restates a status, a transition or a refusal code.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpException, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { ACTION_ROUTE_ACTIONS } from "./pipeline-read";
import { createPipelinePost, patchDesign, readPipelinePost, runStageAction, type StageOutcome, type StageRequest } from "./pipeline.service";
import { ScpRouteError } from "./pipeline-effects";
import { simulatedPublishNow } from "./simulated-publish";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body's control fields (`action`, `expectedStatus`, `actionId`) and the rest as the action's params. A control
 *  field of the wrong type is passed on as a value the machine refuses with its own 400 (after authorization). */
function splitBody(body: unknown): { action: unknown; expectedStatus?: string; actionId?: string; params: Record<string, unknown> } {
  const b = isObject(body) ? body : {};
  const { action, expectedStatus, actionId, ...params } = b;
  return {
    action,
    expectedStatus: expectedStatus === undefined ? undefined : typeof expectedStatus === "string" ? expectedStatus : "__invalid__",
    actionId: actionId === undefined ? undefined : typeof actionId === "string" ? actionId : "__invalid__",
    params,
  };
}

/** Bulk accepts these two (BFF §63.6.7); "send anyway" is not offered in bulk. */
const BULK_ACTIONS = new Set(["send_to_proofread", "approve_copy"]);

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialPipelineController {
  // ── §63.6.1 Create ────────────────────────────────────────────────────────────────────────────────────────────────
  @Post("cycles/:cycleId/posts")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("cycleId") cycleId: string, @Body() body: unknown) {
    const params = isObject(body) ? body : {};
    const r = await createPipelinePost(req.principal, tenantId, cycleId, params);
    return { post: await readPipelinePost(req.principal, tenantId, r.postId), created: r.created };
  }

  // ── §63.6.2 Read ──────────────────────────────────────────────────────────────────────────────────────────────────
  @Get("posts/:postId/pipeline")
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string) {
    return readPipelinePost(req.principal, tenantId, postId);
  }

  // ── §63.6.3 Edit ──────────────────────────────────────────────────────────────────────────────────────────────────
  @Patch("posts/:postId/pipeline")
  async edit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Body() body: unknown) {
    const b = splitBody(body);
    return this.answer(req, await runStageAction(req.principal, { tenantId, postId, action: "edit", params: { fields: b.params.fields }, expectedStatus: b.expectedStatus }));
  }

  // ── §63.6.4 Suggestions ───────────────────────────────────────────────────────────────────────────────────────────
  @Put("posts/:postId/suggestions/:field")
  async suggest(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Param("field") field: string, @Body() body: unknown,
  ) {
    const b = splitBody(body);
    // A PUT always sets: `value` null is the DELETE's job, so a PUT without a value is a missing field.
    const value = b.params.value === null ? undefined : b.params.value;
    return this.answer(req, await runStageAction(req.principal, { tenantId, postId, action: "suggest", params: { field, value }, expectedStatus: b.expectedStatus }));
  }

  @Delete("posts/:postId/suggestions/:field")
  async dropSuggestion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Param("field") field: string) {
    return this.answer(req, await runStageAction(req.principal, {
      tenantId, postId, action: "suggest", params: { field, value: null }, requireExpectedStatus: false,
    }));
  }

  // ── §63.6.5 The one action route ──────────────────────────────────────────────────────────────────────────────────
  @Post("posts/:postId/actions")
  @HttpCode(200)
  async action(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Body() body: unknown) {
    const b = splitBody(body);
    // An action with a route of its own, or a portal decision, is not a value of this route (§63.3.1): the machine's own
    // unknown_action, through the same orchestration so the refusal shape is one.
    const action = typeof b.action === "string" && ACTION_ROUTE_ACTIONS.includes(b.action) ? b.action : "__unknown__";
    return this.answer(req, await runStageAction(req.principal, { tenantId, postId, action, params: b.params, expectedStatus: b.expectedStatus, actionId: b.actionId }));
  }

  // ── §63.10 SCP-Sc: "Publish now (simulated)" ──────────────────────────────────────────────────────────────────────────
  // Not a stage action (the fixture has none for it): a route of its own, which never changes the post's status itself. It moves a
  // queued simulated dispatch's time up to now and runs the status read, whose result (`publisher-result.ts`) makes the post live.
  // 403 (automation, `approve`) · 404 · 409 `not_a_pipeline_post` · `simulation_disabled` · `not_scheduled_by_publisher` ·
  // `simulated_account_required` · `simulated_approval_not_decided` · `simulated_not_dispatched`. See `simulated-publish.ts`.
  @Post("posts/:postId/simulated-publish-now")
  @HttpCode(200)
  async simulatedPublish(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string) {
    const out = await simulatedPublishNow(req.principal, tenantId, postId);
    return { post: await this.readOrNull(req, tenantId, postId), advanced: out.advanced, live: out.live };
  }

  // ── §63.6.6 Designs ───────────────────────────────────────────────────────────────────────────────────────────────
  @Post("posts/:postId/designs")
  @HttpCode(201)
  async addDesign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Body() body: unknown) {
    const b = splitBody(body);
    const out = await runStageAction(req.principal, { tenantId, postId, action: "add_design", params: b.params, expectedStatus: b.expectedStatus });
    return { ...(await this.answer(req, out)), designId: out.out.designId };
  }

  @Patch("posts/:postId/designs/:designId")
  async updateDesign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Param("designId") designId: string, @Body() body: unknown,
  ) {
    await patchDesign(req.principal, tenantId, postId, designId, isObject(body) ? body : {});
    return { post: await readPipelinePost(req.principal, tenantId, postId) };
  }

  @Delete("posts/:postId/designs/:designId")
  async removeDesign(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Param("designId") designId: string) {
    return this.answer(req, await runStageAction(req.principal, {
      tenantId, postId, action: "remove_design", params: { designId }, requireExpectedStatus: false,
    }));
  }

  // ── §63.6.7 Bulk ──────────────────────────────────────────────────────────────────────────────────────────────────
  @Post("posts/actions")
  @HttpCode(200)
  async bulk(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    if (!isObject(body)) throw new BadRequestException({ message: "missing_field", field: "action" });
    if (typeof body.action !== "string") throw new BadRequestException({ message: "missing_field", field: "action" });
    if (!BULK_ACTIONS.has(body.action)) throw new BadRequestException({ message: "invalid_field", field: "action" });
    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new BadRequestException({ message: "invalid_field", field: "items" });
    const results: Array<Record<string, unknown>> = [];
    // Each item runs §63.3.2 on its own, in its own transaction: one refusal never undoes another.
    for (const [i, item] of items.entries()) {
      const it = isObject(item) ? item : {};
      const postId = typeof it.postId === "string" ? it.postId : "";
      const reqItem: StageRequest = {
        tenantId, postId, action: body.action, params: {},
        expectedStatus: typeof it.expectedStatus === "string" ? it.expectedStatus : undefined,
        actionId: typeof it.actionId === "string" ? it.actionId : undefined,
      };
      try {
        const out = await runStageAction(req.principal, reqItem);
        results.push({ postId, ok: true, ...(out.applied.alreadyApplied ? { alreadyApplied: true } : {}), post: await this.readOrNull(req, tenantId, postId) });
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        const r = e.getResponse() as Record<string, unknown> | string;
        const o = typeof r === "string" ? { message: r } : r;
        results.push({
          postId: postId || `items[${i}]`, ok: false, error: o.message,
          ...(o.field ? { field: o.field } : {}), ...(o.detail ? { detail: o.detail } : {}), ...(o.blockers ? { blockers: o.blockers } : {}),
        });
      }
    }
    return { results };
  }

  // ── The answer every write gives ──────────────────────────────────────────────────────────────────────────────────
  private async answer(req: FastifyRequest, out: StageOutcome) {
    const tenantId = (req.params as { tenantId: string }).tenantId;
    const post = await this.readOrNull(req, tenantId, out.postId);
    if (out.applied.alreadyApplied) return { alreadyApplied: true, post, applied: { action: out.applied.action, from: out.applied.from, to: out.applied.to }, warnings: [] };
    return { post, applied: { action: out.applied.action, from: out.applied.from, to: out.applied.to }, warnings: out.out.warnings };
  }

  /** The post after the write, or null when the caller may no longer read it (a discarded post reads 404). */
  private async readOrNull(req: FastifyRequest, tenantId: string, postId: string): Promise<Record<string, unknown> | null> {
    try {
      return await readPipelinePost(req.principal, tenantId, postId);
    } catch (e) {
      if (e instanceof ScpRouteError || (e instanceof HttpException && [403, 404, 409].includes(e.getStatus()))) return null;
      throw e;
    }
  }
}
