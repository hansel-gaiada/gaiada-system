// Shared "platform-wide admin" gate: platform_admin or group_executive, both at GLOBAL scope.
// These admin/systems surfaces are not tenant resources, so the check happens in code rather
// than through Cerbos's per-tenant resource model. Used by admin-systems.controller.ts and
// bot-admin.controller.ts (do not duplicate this predicate elsewhere).
import type { FastifyRequest } from "fastify";

export function isElevated(req: FastifyRequest): boolean {
  return req.principal.roles.some(
    (r) =>
      (r.role === "platform_admin" && r.scopeType === "global") ||
      (r.role === "group_executive" && r.scopeType === "global"),
  );
}
