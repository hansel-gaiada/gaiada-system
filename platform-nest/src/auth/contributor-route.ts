// M5-W1d — the HTTP fence around the `contributor` principal (owner ruling WSK-D84; docs/plans/2026-10-11-m5-writers-room-design.md
// §3.1 item 5, §3.2). The FIRST of the walls; Cerbos's contributor DENYs are the second, the role allow-list (grant path + DB
// guard) the third, and none of them is meant to be enough on its own.
//
// THE RULE. `AuthGuard` calls `enforceContributorFence()` right after the principal is assembled. A principal whose
// `users.kind` is `contributor` passes ONLY when BOTH hold:
//   1. the route handler carries `@ContributorRoute()` (the writers' room BFF, `/me`): everything else answers
//      403 `contributor_route_forbidden` (reason `route_not_open_to_contributors`);
//   2. the principal's assurance is `"high"` from a REAL second factor: `linked` (an OBO envelope, any chat channel or agent)
//      and `low` answer 403 `contributor_route_forbidden` (reason `assurance_high_required`), and so does a `high` that came
//      from the dev-stage SIMULATED step-up (`assuranceSource: "simulated"`, PV-D40), which `applySimulatedStepUp` never
//      grants a contributor anyway. Until the AMR mapper is proven live (W1g) this fails closed for every real login.
// Every other kind passes through untouched: the fence never changes a staff, client, automation or bot request.
//
// WHY THE MARK IS ON THE HANDLER, NEVER THE CLASS. A class-level mark would silently open every route added to that controller
// later. The decorator is a MethodDecorator, and `isContributorRoute()` reads the handler only, so a new route is closed to
// contributors until someone opens it on purpose. `contributor-route.test.ts` enumerates EVERY route of the app and pins the
// marked set exactly; adding or removing a mark is a deliberate, reviewed edit of that list.
//
// WHY NOT `Reflector`. `AuthGuard` has no constructor and is applied with `@UseGuards(AuthGuard)` from ~100 controllers; giving
// it an injected dependency would change how every one of them resolves the guard. Nest's `SetMetadata` is
// `Reflect.defineMetadata` on the handler function, so `Reflect.getMetadata` reads exactly what `Reflector.get` would.
import { ForbiddenException, SetMetadata } from "@nestjs/common";
import type { Principal } from "../rbac/principal";
import { CONTRIBUTOR_KIND, CONTRIBUTOR_ROUTE_FORBIDDEN } from "../rbac/contributor";

export const CONTRIBUTOR_ROUTE_KEY = "gaiada:contributor-route";

/** Opens ONE route handler to the contributor principal (at assurance high). Method-only by type. */
export function ContributorRoute(): MethodDecorator {
  const set = SetMetadata(CONTRIBUTOR_ROUTE_KEY, true);
  return (target, key, descriptor) => {
    set(target, key, descriptor);
  };
}

/** True when this exact handler function is marked. Reads the HANDLER only (see the header). */
export function isContributorRoute(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  return Reflect.getMetadata(CONTRIBUTOR_ROUTE_KEY, handler) === true;
}

export type ContributorFenceRefusal = "route_not_open_to_contributors" | "assurance_high_required";

/** The decision, without the throw (unit-tested). `null` = pass. */
export function contributorFenceRefusal(principal: Principal | undefined, handler: unknown): ContributorFenceRefusal | null {
  if (!principal || principal.kind !== CONTRIBUTOR_KIND) return null;
  if (!isContributorRoute(handler)) return "route_not_open_to_contributors";
  if (principal.assurance !== "high" || principal.assuranceSource === "simulated") return "assurance_high_required";
  return null;
}

/** Throws the typed 403 when the fence refuses. Called by `AuthGuard` once the principal is known. */
export function enforceContributorFence(principal: Principal | undefined, handler: unknown): void {
  const refusal = contributorFenceRefusal(principal, handler);
  if (!refusal) return;
  throw new ForbiddenException({
    message: CONTRIBUTOR_ROUTE_FORBIDDEN,
    reason: refusal,
  });
}
