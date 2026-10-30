// SCP-5h (W5-C4) — client onboarding's Social half (FRONTEND-BFF-CONTRACT §63.29.4; SCP-Q35, SCP-Q36). Mounted under `api/:tenantId/modules/social`, behind
// AuthGuard and ModuleEnabledGuard("social").
//
//   GET  onboarding                              social_post · read       {template, items, canStart}   the clients being onboarded: progress, the next step, the kickoff, the baseline audit
//   POST engagements/:engagementId/onboarding    the four + the project   201 or 200 PM's answer         starts it: the company's template applied to the client's project
//
// ONBOARDING IS A PM PROJECT TEMPLATE, NOT A SECOND TASK SYSTEM (plan §4.5, SCP-D4). The start CALLS PM's `applyProjectTemplate` (one transaction, idempotent on `id`) and its
// refusals pass through unchanged, `template_already_applied` included. Moving the kickoff and ticking a step are PM's own routes (`PATCH pm/template-applications/:id`,
// `PATCH pm/tasks/:taskId`), called by the page with PM's own gates; Social adds nothing to them.
//
// THE START'S GATES (SCP-Q36: onboarding hands about fifteen tasks to people, so the four start it, and they need PM's right on the project too):
//   1. 404 `engagement_not_found` (another company's, a deleted and a malformed id are all absent);
//   2. 403 `not_a_social_approver`: `social_engagement` · `plan` (an officer, a company admin and a Web Dev head are refused; an unattended automation is 403 `automation_cannot_act`);
//   3. 403 (PM's own, generic): `pm_project` · `manage` on the engagement's project, asked when it has one;
//   4. 400 `invalid_field` `{field}`: the body (`id`, `kickoff`, `people.<role>`);
//   5. 409 `no_project`: the client has no live ERP project to make the tasks in (the project IS the one the team's checklist asked for);
//   6. 409 `onboarding_template_not_set`: the company has not chosen a template (or the one it chose was deleted since);
//   7. then PM's apply: 400 `{field: 'people.<role>'}`, 409 `template_already_applied` `{detail: {applicationId}}`, a replayed `id` answers 200 with the same ids.
// Authorization before validation (BFF §63.0): a refused caller always gets 403, never 400 or 409.
//
// THE PEOPLE. `people` defaults to the engagement's officer for `officer` and the caller for `lead`; `client` steps are the client's to provide and PM has no client assignee, so
// they go to the officer, who chases them (63.29.3). The body may name others (`onboarding.ts`'s `startPeople`).
import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize, writeActivity } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { applyProjectTemplate } from "../../pm/pm.controller";
import { socialEngagementResource } from "../pipeline-authz";
import { approverIdsOf, canPlanOf } from "./plan-authz";
import { authorizeCoded } from "./boosts";
import { todayIsoInTz } from "./cycles-data";
import { ScpRouteError } from "./pipeline-effects";
import { isUuid, parseStartBody, startPeople, type OnboardingAnswer } from "./onboarding";
import { loadStartEngagement, readOnboarding, readOnboardingTemplate, readOnboardingTemplateId, readProjectTemplate } from "./onboarding-data";

const SOCIAL = { modules: ["social"] };

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialOnboardingController {
  // ==================================================================== GET onboarding
  @Get("onboarding")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<OnboardingAnswer> {
    await authorize(req.principal, { kind: "social_post", tenantId, module: "social" }, "read");
    const today = todayIsoInTz(config.reportsTz);
    const canPlan = await canPlanOf(req, tenantId);
    return withTenants([tenantId], async (c) => readOnboarding(c, tenantId, today, await readOnboardingTemplate(c, tenantId), canPlan), SOCIAL);
  }

  // ==================================================================== POST engagements/:engagementId/onboarding
  @Post("engagements/:engagementId/onboarding")
  async start(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("engagementId") engagementId: string,
    @Body() body: unknown,
  ) {
    // 1. the engagement
    const engagement = isUuid(engagementId) ? await withTenants([tenantId], (c) => loadStartEngagement(c, tenantId, engagementId.toLowerCase()), SOCIAL) : null;
    if (!engagement) throw new ScpRouteError(404, "engagement_not_found");

    // 2. the four (SCP-Q36), then 3. PM's right on the project, which hands the work to people
    const approverIds = await approverIdsOf(tenantId);
    const callerId = await authorizeCoded(req.principal, socialEngagementResource(tenantId, approverIds, engagement.id), "plan", "not_a_social_approver");
    if (engagement.projectId) await authorize(req.principal, { kind: "pm_project", tenantId, id: engagement.projectId }, "manage");

    // 4. the body
    const input = parseStartBody(body);

    // 5. the project, 6. the company's template
    if (!engagement.projectId) throw new ScpRouteError(409, "no_project");
    const templateId = await withTenants([tenantId], (c) => readOnboardingTemplateId(c, tenantId), SOCIAL);
    const template = templateId ? await withTenants([tenantId], (c) => readProjectTemplate(c, tenantId, templateId)) : null;
    if (!template) throw new ScpRouteError(409, "onboarding_template_not_set");

    // 7. PM's apply: its refusals pass through; a replayed id answers the same application with a 200
    const people = startPeople(template.payload.roles.map((r) => r.key), input.people, engagement.ownerId, callerId);
    const { created, answer } = await applyProjectTemplate(tenantId, callerId, engagement.projectId, {
      id: input.id, templateId: template.id, kickoff: input.kickoff, people,
    });
    reply.status(created ? 201 : 200);
    if (created) await writeActivity(tenantId, callerId, "onboarding_started", "social_engagement", engagement.id, { applicationId: answer.applicationId, kickoff: input.kickoff });
    return answer;
  }
}
