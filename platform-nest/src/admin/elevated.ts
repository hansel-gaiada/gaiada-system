// Shared "platform-wide admin" gate: `platform_admin` at GLOBAL scope.
// These admin/systems surfaces are not tenant resources, so the check happens in code rather
// than through Cerbos's per-tenant resource model. Used by admin-systems.controller.ts and
// bot-admin.controller.ts (do not duplicate this predicate elsewhere).
//
// ⚠ IAM-15 (D-7) REMOVED THE SECOND ARM. This used to accept `group_executive` at global scope too;
// that role no longer exists. The predicate is therefore STRICTLY NARROWER than it was, and that is
// the intended consequence — these are platform/system surfaces, and D-7's whole point is that a
// cross-company BUSINESS role should not reach them.
//
// ⚠ `owner` IS DELIBERATELY NOT ADDED HERE, and adding it would undo IAM-14. D-8 defines owner as
// "everything business + role authoring in owned companies; NO platform/system controls", and the
// owner bundle explicitly excludes the platform keys for that reason. An owner who satisfied
// `isElevated` would reach the systems console — collapsing the platform/business distinction that
// the two-person appointment rule (D-9) depends on being real.
import type { FastifyRequest } from "fastify";

export function isElevated(req: FastifyRequest): boolean {
  return req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
}
