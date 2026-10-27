// SCP-1a — the `plan` gate shared by the allocation routes and the two engagement routes that 63.12 narrows.
//
// `plan` on `social_engagement` is the four social approvers' (SCP-Q18, SCP-Q19; PERMISSION §53.6): the HoD and GM lead seats, the owner,
// the superadmin. A refusal is 403 `not_a_social_approver`. The resource is built from the rows (`loadSocialApproverIds`), never from a
// body. Only a plain Cerbos DENIAL becomes that code: a 401 (a revoked session) passes through, and an `assurance_required` reason (PV5-14)
// is kept beside the code.
//
// This is the same rule `cycles.controller.ts` (SCP-1c) applies privately; it is repeated here as a module so `social.controller.ts` can
// ask it too without importing a controller.
import { ForbiddenException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import { check } from "../../../rbac/cerbos";
import { loadSocialApproverIds, socialEngagementResource } from "../pipeline-authz";

/** The company's Social Media and GM lead-seat holders, read in the company's own scope. */
export const approverIdsOf = (tenantId: string): Promise<string[]> =>
  withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), { modules: ["social"] });

/** `plan` on `social_engagement` (the four approvers), or 403 `not_a_social_approver`. */
export async function authorizePlan(req: FastifyRequest, tenantId: string, engagementId?: string): Promise<void> {
  const resource = socialEngagementResource(tenantId, await approverIdsOf(tenantId), engagementId);
  try {
    await authorize(req.principal, resource, "plan");
  } catch (e) {
    if (e instanceof ForbiddenException) {
      const res = e.getResponse() as { reason?: unknown };
      throw new ForbiddenException({ message: "not_a_social_approver", ...(typeof res?.reason === "string" ? { reason: res.reason } : {}) });
    }
    throw e;
  }
}

/** Whether the caller may plan (the UI's `canPlan`). A plain decision: it never throws on a denial. */
export async function canPlanOf(req: FastifyRequest, tenantId: string): Promise<boolean> {
  const d = await check(req.principal, socialEngagementResource(tenantId, await approverIdsOf(tenantId)), "plan");
  return d.allow;
}
