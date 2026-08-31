// WSK-12 — the Zone A HTTP surface the `wd-zoneb-intake` n8n flow's MCP call lands on, once
// wired (see this ticket's report for the exact `mcp-hub/src/automation-policy.ts` allow-list
// entry and `webdevModule.mcpTools` addition that make that call reachable — neither is made in
// this ticket, both are reported).
//
//   POST /api/:tenantId/modules/webdev/zoneb-events  -> 201 (new) | 200 (idempotent replay) | 400 | 403 | 404
//
// A SEPARATE controller from `WebdevController` (not an addition to it) — that file is PRV-02's
// and is not this ticket's owned path (the ticket's hard constraints: report edits to existing
// files, do not make them). NestJS has no trouble registering two controllers under the same
// `@Controller()` path prefix as long as their own route sets are disjoint, which they are here.
//
// ── WHY THIS ENDPOINT EXISTS AT ALL (justifying the "new module dir/new controller ONLY if
//    genuinely needed" clause) ───────────────────────────────────────────────────────────────
// `automation/CLAUDE.md`'s backbone rule is absolute: "n8n = orchestration · MCP = access · custom
// services = logic. Workflows hold no business logic and touch no database." The `wd-zoneb-intake`
// flow's "dedup via the table" step (§10) therefore CANNOT be a Postgres node — it has to be an
// mcp-hub tool call, and mcp-hub's module-tool aggregation is "nothing hub-side hardcoded" (§09):
// a module declares a `pathTemplate` and mcp-hub calls it. Something has to serve that path. This
// controller is the minimal thing that does — it does not re-implement or pre-empt WSK-19's own
// contract-snapshot mirror surface, which is a completely different resource.
//
// ── AUTHZ NOTE ──────────────────────────────────────────────────────────────────────────────────
// `authorize()` runs against the NEW Cerbos resource kind `webdev_zoneb_event`
// (resource_webdev_zoneb_event.yaml, this ticket's own new file — no existing Cerbos file was
// touched). An automation service account calling this endpoint needs a real `company_memberships`
// row with a role this policy grants `record` to (company_admin/manager/module_manager) in the
// target tenant — provisioning that account is WSK-31's job ("wf:webdesk account"), flagged in the
// ticket report, not built here.
import { BadRequestException, Body, Controller, HttpCode, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { validateZoneBEvent } from "./zoneb-event-schema";
import { recordZoneBEvent } from "./zoneb-events.service";

@Controller("api/:tenantId/modules/webdev")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class ZoneBEventsController {
  @Post("zoneb-events")
  @HttpCode(200)
  async record(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; inserted: boolean }> {
    await authorize(req.principal, { kind: "webdev_zoneb_event", tenantId, module: "webdev" }, "record");

    const checked = validateZoneBEvent(tenantId, body);
    if (!checked.ok) throw new BadRequestException({ message: checked.reason });

    const outcome = await recordZoneBEvent(tenantId, checked.value);
    if (outcome.inserted) {
      reply.status(201);
      await writeActivity(tenantId, req.principal.userId, "recorded", "webdev_zoneb_event", outcome.id, {
        kind: checked.value.kind, eventId: checked.value.eventId,
      });
    }
    // 200 on an idempotent replay — same status-split doctrine `WebdevController.provision()`
    // already uses for its own "existing" outcome: the loser of a race (or a genuine retry) gets
    // the SAME recorded fact back, never a duplicate.
    return { id: outcome.id, inserted: outcome.inserted };
  }
}
