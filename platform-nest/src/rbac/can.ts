// IAM-05a — the published server-side permission-check entry point. Wraps `check()`
// (cerbos.ts); every existing `authorize(...)`/`check(...)` call site keeps working
// unchanged — this file adds a new name, it does not replace anything.
//
// can() is a QUESTION, not a GUARD: like `check()`, it returns a boolean and does nothing
// else. It does NOT audit the decision (`auditDecision`) and does NOT re-check D11
// `sessionVersion` on mutations — that remains `authorize()`'s job (`core/http.ts`), which
// throws + audits + enforces D11 and is unchanged by this ticket. A route that currently
// calls `authorize(principal, resource, action)` should keep doing so; `can()` is for the
// growing set of callers that need an answer, not a thrown exception — a BFF endpoint
// reporting "can this caller create a task" (IAM-05c), a controller branching on whether to
// attempt a privileged path, PM/Web Dev code asking one-off questions about a principal.
//
// ---------------------------------------------------------------------------------------
// WHICH ONE DO I CALL?
// ---------------------------------------------------------------------------------------
//
// `can(principal, key, resource)` — DEFAULT. Use this unless you have a specific reason not
// to. Always asks Cerbos, with the real resource attributes. Correct for EVERYTHING,
// including permissions whose grant depends on a condition Cerbos evaluates but a flat
// permission list cannot — ownership (`ownerId`), the HR self-service subject
// (`subjectUserId`), team scope (`teamId`), an assurance floor (`notLow`/`high`), or the
// platform_admin/group_executive wildcard bypass. IAM-04c ruled the bypass stays a per-kind
// Cerbos rule, never a `*` permission — `can()` resolves it correctly for free, because it
// always goes through Cerbos, the exact place that rule lives.
//
// `can.scopeOnly(principal, key, scope)` — NARROW, OPT-IN FAST PATH. Answers strictly from
// the principal's already-resolved `perms` (IAM-03a) — zero network round trip, but also
// ZERO awareness of any resource-level condition. Use this ONLY for genuinely scope-only
// questions — should a nav item render, should a "New X" button show, pre-filtering a list
// before the real per-row check runs. NEVER use it to gate access to one specific resource:
// it WILL disagree with `can()` and over-grant for any permission whose real Cerbos rule is
// condition-dependent. This is not a hypothetical — it is the exact hazard IAM-04b's pilot
// caught and fixed before landing (see the IAM-04 report §4):
//   - a `member`'s `hr.case.read` bundle entry is indistinguishable, once flattened into
//     `perms`, from `company_admin` holding the same key UNCONDITIONALLY — the real Cerbos
//     rule restricts `member` to their OWN case (`subjectUserId == principal.id`).
//   - `team_lead`'s `pm.task.*` bundle entries are PROVABLY unreachable at any scope
//     (`pm.controller.ts` never sets `resource.attr.teamId`), yet the bundle row exists.
// Both are pinned as disagreement tests in `can.test.ts`. If you are not sure which one you
// need, you need `can()`.
//
// Deliberately TWO DIFFERENTLY NAMED functions, not one function that branches on argument
// shape or tries to detect intent. Reproducing IAM-04b's 403->200 regression at the API layer
// would look exactly like a `can()` that silently picked the cheap path when it guessed a
// question was "probably scope-only" — naming forces the caller to say which question they
// are actually asking, in code review, not just in a comment.
//
// ---------------------------------------------------------------------------------------
// THE 15 RELATIONSHIP PERMISSIONS AND THE WILDCARD BYPASS
// ---------------------------------------------------------------------------------------
//
// The 15 `class: "relationship"` catalog permissions (held by owning the resource, or via the
// MCP hub channel — never by any role, IAM-04c Ruling 3) can never appear in a principal's
// `perms`: 0093's `role_permissions_reject_relationship` trigger makes it structurally
// impossible for one to become a `role_permissions` row, and `assemblePrincipal()`'s own
// query re-filters on `class = 'grantable'` as defense in depth. `can()` still answers them
// correctly, because Cerbos's own per-kind ownership/provenance rules evaluate them directly
// (e.g. `assistant.agent_run.read`'s rule checks `resource.attr.origin ==
// "assistant_handoff"` plus ownership, not any role). `can.scopeOnly()` REFUSES to answer a
// relationship-class key at all — it throws, pointing at `can()` — rather than silently
// returning `false`. A relationship permission is never a scope-only question in the first
// place; a silent `false` would read as "checked, correctly denied" when it is really "wrong
// tool for this question."
//
// ---------------------------------------------------------------------------------------
// EXAMPLES
// ---------------------------------------------------------------------------------------
//
//   // Gate one write — same shape as an existing authorize() call site, but as a question:
//   if (!(await can(principal, "pm.task.update", { id: taskId, tenantId }))) {
//     throw new ForbiddenException();
//   }
//
//   // A condition-dependent permission — pass the real attribute the policy checks:
//   await can(principal, "hr.case.read", { id: caseId, tenantId, module: "hr", subjectUserId: employeeId });
//
//   // UI-gating fast path — "does this principal hold pm.task.create ANYWHERE in this
//   // company", used to decide whether to render a "New task" button — NOT to authorize
//   // the resulting POST (that call site uses `can()`, same key, with the real resource):
//   const showCreateButton = can.scopeOnly(principal, "pm.task.create", { scopeType: "company", scopeId: tenantId });
//
// You never need to know or pass the underlying Cerbos resource `kind` — the catalog
// (`permission-catalog.json`, IAM-01b) already carries `cerbosKind`/`cerbosAction` for every
// key, so `can()` derives both and calls `check()` for you. That mapping is exactly what
// IAM-01a's catalog exists to hide from callers.
import { check, type Resource } from "./cerbos";
import { principalHasPermission, type Principal, type PermissionGrant } from "./principal";
import permissionCatalog from "./permission-catalog.json";

interface CatalogEntry {
  key: string;
  cerbosKind: string;
  cerbosAction: string;
  class: string; // "grantable" | "relationship" (IAM-01b) — compared by value, not narrowed,
  // so this file never has to be kept in sync with the JSON's own literal-type inference.
}

const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(
  (permissionCatalog.permissions as CatalogEntry[]).map((p) => [p.key, p]),
);

function catalogEntry(fnName: string, permissionKey: string): CatalogEntry {
  const entry = CATALOG.get(permissionKey);
  if (!entry) {
    throw new Error(
      `${fnName}(): "${permissionKey}" is not in the permission catalog ` +
        `(src/rbac/permission-catalog.json). Check for a typo, or add it to the catalog ` +
        `(IAM-01b) before wiring authorization to it.`,
    );
  }
  return entry;
}

/** Everything `can()` needs about the resource EXCEPT `kind` — `can()` derives `kind` from
 *  the catalog entry for the permission key, so callers never name a raw Cerbos kind. */
export type PermissionResourceAttrs = Omit<Resource, "kind">;

/** A bare scope reference — the same union `PermissionGrant`/`RoleGrant` already use. */
export type ScopeRef = { scopeType: PermissionGrant["scopeType"]; scopeId: string | null };

/**
 * can(principal, permissionKey, resource) — THE authoritative permission question. Always
 * asks Cerbos (via `check()`), with the real resource attributes. See the file header for
 * when to prefer this over `can.scopeOnly()` (short answer: always, unless you specifically
 * need the fast path's tradeoffs).
 *
 * Throws if `permissionKey` is not in the catalog — a typo or an uncatalogued key is a bug to
 * surface immediately, not a silent `false` that looks like a correct deny.
 */
export async function can(
  principal: Principal,
  permissionKey: string,
  resource: PermissionResourceAttrs,
): Promise<boolean> {
  const entry = catalogEntry("can", permissionKey);
  const decision = await check(principal, { ...resource, kind: entry.cerbosKind }, entry.cerbosAction);
  return decision.allow;
}

/**
 * can.scopeOnly(principal, permissionKey, scope) — the narrow, non-Cerbos fast path. See the
 * file header for the hazard this carries and when it is (and is not) safe to use.
 *
 * Throws for any `class: "relationship"` key — never returns `false` for one, because a flat
 * `false` there would be indistinguishable from "checked, correctly denied."
 */
function scopeOnlyImpl(principal: Principal, permissionKey: string, scope: ScopeRef): boolean {
  const entry = catalogEntry("can.scopeOnly", permissionKey);
  if (entry.class === "relationship") {
    throw new Error(
      `can.scopeOnly(): "${permissionKey}" is relationship-class (held by owning the ` +
        `resource, or via the MCP hub channel — never by any role/bundle, IAM-04c Ruling 3). ` +
        `There is no scope-only answer to give. Use can(principal, "${permissionKey}", resource) ` +
        `instead, with the real resource attributes.`,
    );
  }
  return principalHasPermission(principal, permissionKey, scope.scopeType, scope.scopeId);
}

// Function + namespace declaration merging (standard TS pattern) — `can.scopeOnly` is a real,
// independently-typed export reachable off the same name callers already imported, not a
// bolted-on property. See the file header for why this is two names and not one.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace can {
  export const scopeOnly = scopeOnlyImpl;
}
