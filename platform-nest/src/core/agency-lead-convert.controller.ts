// AD-6 — the agency-lead CONVERT endpoint. Design:
// docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §4.2 (what conversion creates) · §4.3 (delegation) · §5.2 (authz) · §6.2 (idempotency) · §8(b)
//
// A SEPARATE controller from the triage one on purpose (per this ticket's brief): another agent owns
// `agency-leads.controller.ts` (read/triage/decline/nurture), and `approvals-decide.controller.ts`
// vs `approvals.controller.ts` is the house precedent for splitting a mutating decision surface from
// the read/list one it decides about.
//
// Cerbos action is `convert`, deliberately NOT `update` (design §5.2): minting a client and a project
// is a different act from editing a phone number, and an AM who may triage should not automatically
// convert.
//
// ── §8(b): THIS WRITE IS MEDIUM-IMPACT AND D14-GATED, AND THE RESUME PATH IS KNOWN BROKEN ──────────
// The agentic-native plan's highest-leverage open item is "the D14 resume path is broken — approving
// a suspended write currently executes nothing." `lead.convert` is medium-impact by the design's own
// §8 table, so an AGENT-initiated convert (via the AD-8 MCP tool, once it ships) would suspend at the
// mcp-hub gate and never execute. That gate and its impact classification live in the MCP tool
// definition (a module's `mcpTools` list, e.g. `modules/agency/index.ts`) and in this file's sibling
// `core/approval-executables.ts` registry — BOTH are out of this ticket's file list (AD-8 owns "MCP
// tools agency_intake.* + golden case", and is explicitly the ticket that "must assert D14
// suspension"). This endpoint is therefore written to be a clean, reusable HTTP surface for a HUMAN
// staff session today; nothing here registers an executable-approval entry, and
// `agency-lead-convert.test.ts` asserts that absence directly (`getExecutable("agency_intake.convert")`
// is undefined) so the suspension finding is pinned rather than merely narrated.
import { BadRequestException, ConflictException, Controller, HttpCode, NotFoundException, Param, Post, Body, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import { notifyBestEffort } from "./client-notify";
import { convertAgencyLead, normalizeDelegationsInput } from "./agency-lead-convert.service";

@Controller("api")
@UseGuards(AuthGuard)
export class AgencyLeadConvertController {
  @Post(":tenantId/agency/leads/:leadId/convert")
  @HttpCode(200)
  async convert(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("leadId") leadId: string,
    @Body() body: { delegations?: unknown },
  ) {
    // AUTHORIZE BEFORE VALIDATE (pipeline.controller.ts's createProject / webdev's triage precedent):
    // a caller who may not convert learns only that, and no future required body field can quietly
    // demote a denial test to a payload 400. Nothing above depends on the body.
    await authorize(req.principal, { kind: "agency_lead", tenantId, id: leadId, module: "agency" }, "convert");
    const delegations = normalizeDelegationsInput(body?.delegations);
    if (!req.principal.userId) {
      // The converting actor becomes pipeline_runs.owner_id / projects.owner_id / client_contacts
      // .invited_by, all of which are `uuid REFERENCES users(id)` — an automation/service principal
      // with no userId has nothing to place there, and the honest response is a typed 400 rather than
      // a null that later reads as "nobody converted this".
      throw new BadRequestException("convert requires an authenticated user principal");
    }

    const result = await convertAgencyLead({
      tenantId,
      leadId,
      actorUserId: req.principal.userId,
      delegations,
    });

    if (result.outcome === "not_found") throw new NotFoundException("lead not found");
    if (result.outcome === "conflict") {
      // The loser of a race (or a retry, or a double-click) gets the EXISTING artifact, not a twin and
      // not a bare error — mirrors `existingStageForRepeatedCreate`'s and MI-03's triage ruling.
      // `existing` must survive HttpErrorFilter's `{error}` reshape, which is why that filter forwards
      // this field (see webdev-change-requests.controller.ts's identical AC).
      throw new ConflictException({
        message: "lead already converted (or no longer open for conversion)",
        existing: result.existing,
      });
    }

    await writeActivity(tenantId, req.principal.userId, "converted", "agency_lead", leadId, {
      clientId: result.clientId, projectId: result.projectId, runId: result.runId,
    });

    // Best-effort, AFTER commit (client-notify.ts:63-68: a notify() failure must never turn a real
    // write into a 500 the caller might retry into a duplicate). Design §4.2 step 8: the AM and the
    // new client contact.
    const recipients = [
      ...(result.ownerId ? [result.ownerId] : []),
      ...(result.contactUserId ? [result.contactUserId] : []),
    ];
    if (recipients.length) {
      await notifyBestEffort(tenantId, req.principal.userId, recipients, "agency.lead.converted", {
        title: `${result.orgName} is now a client — delivery has started`,
        href: `/pipeline/${result.runId}`,
        entityType: "pipeline_run",
        entityId: result.runId,
        severity: "info",
      });
    }

    return {
      id: leadId,
      status: "converted",
      clientId: result.clientId,
      projectId: result.projectId,
      runId: result.runId,
      // AD-6b: what was delegated and to whom, including fallbacks (`source: "owner_fallback"`) and
      // roles that could not be placed at all (`source: "unresolved"`, `assigneeId: null`, `reason`
      // set) — see agency-lead-convert.service.ts's `DelegationReportEntry`. The parallel-built
      // team-facing UI renders this; a silently missing delegation is the failure mode this ticket
      // exists to remove, so it is never trimmed out of the response.
      delegations: result.delegations,
    };
  }
}
