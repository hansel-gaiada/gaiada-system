// DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.3, PERMISSION-CONTRACT §38c) — who may read whose per-person activity.
//
// Moved verbatim out of `modules/pm/pm.controller.ts` (`assertProductivityReadAllowed`), which stays the caller for
// `GET /pm/productivity` with UNCHANGED behaviour; the activity series, the day read and `GET /work-activity?personId=` use
// the same function, so the rule has one implementation:
//   - yourself;
//   - the `unrestricted` or `company_wide` person-axis tier (HR's people readers included);
//   - a `unit_scoped` caller (a head, or a manager) for a person in their led scope (TR-25);
//   - anyone else: 403 `outside your reporting line`.
//
// Why this is its own function and not a bare `assertPersonInLedScope`: that function's `self_only` branch assumes Cerbos
// already denied a foreign-subject read for that tier (true for `report_document`, which has its own `owns` condition).
// No resource-specific policy exists for "someone's activity", and the base gate (`pm_task:read`, `work_activity:read`)
// carries no subject, so Cerbos cannot have filtered `self_only` here. The self_only branch is enforced explicitly.
import { ForbiddenException } from "@nestjs/common";
import { withTenants } from "../db";
import { config } from "../config";
import { PERSON_SCOPE_MODULES, OUT_OF_LINE_MESSAGE, assertPersonInLedScope, personAxisTier, todayIsoInTz } from "../modules/reports/person-scope";
import type { Principal } from "../rbac/principal";

export async function assertPersonAxisReadAllowed(principal: Principal, tenantId: string, targetUserId: string): Promise<void> {
  if (principal.userId && principal.userId === targetUserId) return;
  const tier = personAxisTier(principal, tenantId);
  if (tier === "unrestricted" || tier === "company_wide") return;
  if (tier === "self_only") throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
  // unit_scoped: narrowed to the caller's own led-unit subtree, exactly as `/reports` does.
  const asOf = todayIsoInTz(config.reportsTz);
  await withTenants(
    [tenantId],
    (c) => assertPersonInLedScope(c, tenantId, principal, targetUserId, asOf),
    { modules: PERSON_SCOPE_MODULES },
  );
}
