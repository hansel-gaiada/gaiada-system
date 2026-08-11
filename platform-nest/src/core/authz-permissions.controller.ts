// IAM-05c — the caller's EFFECTIVE PERMISSIONS FOR A SCOPE, published as a BFF endpoint so the
// UI gates on server truth instead of re-deriving it. Reuses `can.scopeOnly()` (IAM-05a) as its
// only authorization primitive — this file adds no new authorization mechanism, it only asks
// the published entry point the same question 215 times and reports which answers were "yes".
//
// ---------------------------------------------------------------------------------------
// THE CENTRAL DESIGN CONSTRAINT — read this before consuming the response.
// ---------------------------------------------------------------------------------------
// A bulk "everything you can do" answer can ONLY be honestly built from SCOPE-ONLY resolution
// (`can.scopeOnly()`). Condition-dependent grants — ownership (`ownerId`), the HR self-service
// subject (`subjectUserId`), team scope (`teamId`), an assurance floor (`notLow`/`high`) —
// depend on a SPECIFIC resource and cannot be answered for a whole scope in advance. This
// endpoint's response is a set of SCOPE-LEVEL permissions, not a promise that the caller may
// exercise any of them against any resource in that scope. A UI (or any consumer) that treats
// `scopeLevelPermissions` as "may do X to any resource" reproduces the IAM-04b regression
// (permission path granting what the role path denies) at the UI layer — the exact hazard
// `can.scopeOnly()`'s own header warns about, now at a fan-out of up to 215 keys instead of one.
//
// The field is named `scopeLevelPermissions`, not `permissions` or `effectivePermissions`, so
// the name states what it answers rather than what a consumer might wish it answered. Gating
// access to ONE specific resource — the thing this endpoint is NOT for — always goes through
// `can(principal, key, resource)` instead, with the real resource attributes.
//
// ---------------------------------------------------------------------------------------
// THE 15 RELATIONSHIP PERMISSIONS
// ---------------------------------------------------------------------------------------
// Never asked about here (this handler only iterates `class: "grantable"` catalog entries), and
// structurally cannot appear in `principal.perms` regardless (0093's DB trigger +
// `assemblePrincipal()`'s own filter, IAM-03a). Rather than silently omitting them, the response
// LISTS them by name in `excludedRelationshipClass` — a constant, catalog-derived list, the same
// for every principal and every scope — so a consumer sees explicitly that these 15 exist and
// are never answerable at scope level, instead of having to notice their absence.
//
// ---------------------------------------------------------------------------------------
// THE WILDCARD BYPASS (IAM-04c) — decided and documented, not left implicit
// ---------------------------------------------------------------------------------------
// IAM-04c ruled the platform_admin/group_executive superadmin bypass stays a per-kind Cerbos
// rule and that no `*` permission is ever minted. `can()` resolves that bypass correctly for
// free because it always asks Cerbos live. `scopeLevelPermissions` here does NOT ask Cerbos live
// (that is the entire point of a bulk answer with no N round trips) — it answers from
// `principal.perms`, which is populated from `role_permissions` (migration 0094), a SNAPSHOT of
// what each role's Cerbos rules — including its wildcard rules — granted at the time the bundle
// was last generated/regenerated.
//
// Verified in this session (role-permission-bundles.json `_meta.counts.perRole`): `platform_admin`
// holds all 215/215 grantable keys, `group_executive` holds 118/215 — both figures are the
// WILDCARD-EXPANDED bundle IAM-02a produced and IAM-02b's parity suite (22/22, teeth-proven)
// keeps pinned against live Cerbos decisions. So TODAY, for both bypass roles, this endpoint's
// `scopeLevelPermissions` already reflects their real reach over the grantable set — verified
// live below (`authz-permissions.controller.test.ts`'s platform_admin full-catalog sweep against
// `can()`).
//
// What is NOT solved, and cannot be solved without giving up the "no N round trips" property:
// bundle staleness. If a future Cerbos policy edit grants a bypass role a NEW kind's wildcard
// before `role_permissions` is regenerated and re-migrated, `can()` would see it immediately (it
// always asks Cerbos) and this endpoint would NOT, until the next regen. That is a real,
// documented limitation of every snapshot-based answer, not specific to this endpoint — the same
// tradeoff `can.scopeOnly()`'s own header names for condition-dependent grants. DECISION: rather
// than hide that limitation, every response for a principal holding a known bypass role names it
// in `wildcardBypassRoles`, with the caveat text calling out precisely this risk, so a consumer
// with a bypass-holding principal is told "this list may be a floor, not a ceiling, for this
// principal — go to `can()` for authoritative per-resource answers" rather than left to assume
// completeness. `WILDCARD_BYPASS_ROLES` below is intentionally the same two role names IAM-04c's
// bypass ruling and `can.ts`'s own header cite — not re-derived from anything, because there is
// nothing else to derive it from (Cerbos policies carry no queryable "this role is a bypass role"
// flag; it is institutional knowledge the same way the rest of the IAM-04c ruling is).
import { Controller, ForbiddenException, Get, Param, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { can, type ScopeRef } from "../rbac/can";
import type { Principal } from "../rbac/principal";
import { AuthGuard } from "../auth/guards";
import permissionCatalog from "../rbac/permission-catalog.json";

interface CatalogEntry {
  key: string;
  class: string; // "grantable" | "relationship" — compared by value, as can.ts already does.
}

const CATALOG = permissionCatalog.permissions as CatalogEntry[];
const GRANTABLE_KEYS: readonly string[] = CATALOG.filter((p) => p.class === "grantable")
  .map((p) => p.key)
  .sort();
/** Constant across every response — the 15 keys that can never be answered at scope level
 *  (relationship-class, IAM-04c Ruling 3). Computed once from the catalog, not per request. */
const EXCLUDED_RELATIONSHIP_CLASS: readonly string[] = CATALOG.filter((p) => p.class === "relationship")
  .map((p) => p.key)
  .sort();

/** The two role names IAM-04c's bypass ruling documents as carrying Cerbos's per-kind `*`
 *  wildcard rule (56 of 61 kinds). Not derived from anything queryable — Cerbos policies carry no
 *  "this role is a bypass role" flag, so this is the same institutional fact `can.ts`'s header
 *  and the IAM-04c ruling doc both name. See the file header for why holding one of these matters
 *  for how this endpoint's answer should be read. */
const WILDCARD_BYPASS_ROLES: readonly string[] = ["platform_admin", "group_executive"];

export const EFFECTIVE_PERMISSIONS_CAVEAT =
  "scopeLevelPermissions answers 'does this principal hold this permission SOMEWHERE in " +
  "this scope', resolved from the pre-computed role→permission bundle with NO knowledge of " +
  "any resource-level condition (ownerId, subjectUserId, teamId, assurance floors). It can " +
  "OVER-report for one specific resource whose real Cerbos rule is condition-dependent, and " +
  "(only for roles listed in wildcardBypassRoles) it can UNDER-report if the bundle has drifted " +
  "behind a live Cerbos policy change. Never treat this list as 'may do X to any resource' — " +
  "gating access to ONE specific resource, or getting a fully authoritative answer for a " +
  "bypass-holding role, must go through can(principal, key, resource) instead.";

export interface EffectivePermissionsResponse {
  scopeType: ScopeRef["scopeType"];
  scopeId: string | null;
  scopeLevelPermissions: string[];
  excludedRelationshipClass: readonly string[];
  wildcardBypassRoles: string[];
  caveat: string;
}

/** The pure computation, exported for unit testing without any Nest/HTTP/DB scaffolding —
 *  same shape of split as `can.ts` keeping `scopeOnlyImpl` a plain function. Loops the catalog's
 *  215 grantable keys through `can.scopeOnly()` (IAM-05a) — synchronous, no Cerbos round trip,
 *  no DB — and reports which the principal holds at `scope`. */
export function computeEffectivePermissions(principal: Principal, scope: ScopeRef): EffectivePermissionsResponse {
  const held = GRANTABLE_KEYS.filter((key) => can.scopeOnly(principal, key, scope));
  const wildcardBypassRoles = [...new Set(principal.roles.filter((r) => WILDCARD_BYPASS_ROLES.includes(r.role)).map((r) => r.role))].sort();
  return {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    scopeLevelPermissions: held,
    excludedRelationshipClass: EXCLUDED_RELATIONSHIP_CLASS,
    wildcardBypassRoles,
    caveat: EFFECTIVE_PERMISSIONS_CAVEAT,
  };
}

/** ETag over exactly the inputs that can change the answer: identity, session version (D11 —
 *  a revoked/downgraded principal must never be served a stale cached response), scope, and the
 *  computed permission set + bypass flag. `sessionVersion` is part of the hash BY CONSTRUCTION,
 *  not as a separate invalidation step — a session_version bump changes the principal's fresh
 *  read (assemblePrincipal() re-queries it every request, unchanged by this ticket), which
 *  changes this hash, which makes any previously cached ETag stop matching. No explicit
 *  cache-purge mechanism exists or is needed: the cache key IS the invalidation signal. */
function etagFor(principal: Principal, body: EffectivePermissionsResponse): string {
  const material = JSON.stringify({
    userId: principal.userId,
    sessionVersion: principal.sessionVersion,
    scopeType: body.scopeType,
    scopeId: body.scopeId,
    perms: body.scopeLevelPermissions,
    bypass: body.wildcardBypassRoles,
  });
  return `"${createHash("sha256").update(material).digest("hex")}"`;
}

/** Applies the Cache-Control/ETag headers and, on a matching If-None-Match, short-circuits to a
 *  bodyless 304 — otherwise returns the body for Nest to send normally. `@Res({passthrough:
 *  true})` (same pattern as `webdev.controller.ts`'s `provision()`) lets this set headers/status
 *  while Nest still owns serialization for the 200 path. */
function respondCacheable(req: FastifyRequest, reply: FastifyReply, body: EffectivePermissionsResponse) {
  const etag = etagFor(req.principal, body);
  reply.header("cache-control", "private, max-age=30, must-revalidate");
  reply.header("etag", etag);
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch === etag) {
    reply.status(304);
    return undefined;
  }
  return body;
}

@Controller("api")
@UseGuards(AuthGuard)
export class AuthzPermissionsController {
  /**
   * GET /api/:tenantId/authz/permissions — company-scope effective permissions. 403 (never 404)
   * for a caller with no membership in `tenantId` and no global-admin bypass — same rule
   * `ModuleCatalogController.enabled()` already applies, so this endpoint's tenancy gate does not
   * invent a new pattern.
   */
  @Get(":tenantId/authz/permissions")
  companyScoped(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
  ): EffectivePermissionsResponse | undefined {
    const isAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    if (!isAdmin && !req.principal.companies.includes(tenantId)) {
      throw new ForbiddenException("not a member of this company");
    }
    const body = computeEffectivePermissions(req.principal, { scopeType: "company", scopeId: tenantId });
    return respondCacheable(req, reply, body);
  }

  /**
   * GET /api/authz/permissions — global-scope effective permissions. Always answerable for any
   * authenticated principal (their own global-scope grants only) — no tenancy gate needed
   * because "global" names no company. This is what a principal with zero company memberships
   * (e.g. a `group_executive`-shaped seed, memory `org-structure-contract` et al.) uses to learn
   * its own cross-company reach without first picking a company.
   */
  @Get("authz/permissions")
  globalScoped(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): EffectivePermissionsResponse | undefined {
    const body = computeEffectivePermissions(req.principal, { scopeType: "global", scopeId: null });
    return respondCacheable(req, reply, body);
  }
}
