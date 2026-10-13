// Who may open each page of the Admin area (DW-D20, plan §11.4): a page is reachable only by people
// allowed to use it, and everyone else gets a 404. Pure and client-safe, like `lib/workspaceAccess.ts`.
//
// Each predicate mirrors the gate of the endpoint that carries the page's PRIMARY content, not the
// menu's gate (`ADMIN_ROWS` in `lib/workspaces.ts`). Where they differ the endpoint wins, so a page
// whose data the person may read never 404s. The server stays the authority and every page keeps its
// own soft refusal for a read the server denies; this table only decides "does the UI acknowledge the
// page at all".
//
// Cerbos reads below are `platform-nest/cerbos/policies/resource_*.yaml`, the role bundles are
// `platform-nest/src/rbac/role-permission-bundles.json`; a derived role matches a grant at global
// scope or at company scope on the tenant, which is what `holdsAt` does.
//
// A route this table does not know returns `undefined` from `adminRouteAllowed`: nothing new 404s by
// accident.
import type { Me } from "@/lib/platform";
import { CLIENT_SIDE_ROLES, ROLE_CAPS, SCOPED_DATA_ROLES, isElevated } from "@/lib/rbac";
import { isPlatformOperator, isRootOwner } from "@/lib/companyContext";

type Pred = (me: Me, tenantId: string | null) => boolean;

/** Holds one of `roles` at global scope, or at company scope on the tenant. With no tenant (nothing
 *  to compare against) a company-scoped grant counts, so a missing tenant never produces a 404. */
function holdsAt(me: Me, roles: readonly string[], tenantId: string | null): boolean {
  return me.roles.some(
    (g) =>
      roles.includes(g.role) &&
      (g.scopeType === "global" || (g.scopeType === "company" && (tenantId == null || g.scopeId === tenantId))),
  );
}

/** A grant whose role the UI does not model (`ROLE_CAPS`, the client side, the data-scoped staff
 *  roles). The server may still give it access through a role's permission rows, which the browser
 *  cannot see, so the table does not deny it: the page's own soft refusal answers instead. */
function holdsUnmodelledRole(me: Me, tenantId: string | null): boolean {
  return me.roles.some(
    (g) =>
      !Object.prototype.hasOwnProperty.call(ROLE_CAPS, g.role) &&
      !CLIENT_SIDE_ROLES.has(g.role) &&
      !SCOPED_DATA_ROLES.has(g.role) &&
      (g.scopeType === "global" || (g.scopeType === "company" && (tenantId == null || g.scopeId === tenantId))),
  );
}

/** platform_admin (global), a role of this set in the tenant, or a role the UI cannot model. */
const tenantRoles = (roles: readonly string[]): Pred => (me, t) =>
  isElevated(me) || holdsAt(me, roles, t) || holdsUnmodelledRole(me, t);

/** `resource_user.yaml` read (`GET /api/:t/users`, admin-identity.controller.ts:180-186): company_admin, manager, owner. */
const USERS_READ = ["company_admin", "manager", "owner"] as const;
/** `resource_identity_link.yaml` / `resource_compliance_gate.yaml` / `resource_service_assignment.yaml` read:
 *  company_admin and owner (bundles: core.*.read). */
const ADMIN_TIER = ["company_admin", "owner"] as const;
/** `resource_custom_field.yaml` create/update/delete: company_admin and manager; module toggle
 *  (`resource_company.yaml` update): company_admin, owner. The page does both. */
const MODULES_USE = ["company_admin", "manager", "owner"] as const;
/** admin-systems.controller.ts:168-175 `isItOrPlatformOperator`: workflows and executions are read by IT too. */
const IT_ROLES = ["it_admin", "it_manager", "it"] as const;

const anyScopeIt: Pred = (me) => me.roles.some((g) => (IT_ROLES as readonly string[]).includes(g.role));
const operator: Pred = (me) => isPlatformOperator(me);

export interface AdminRoute {
  /** The route pattern as a path prefix: it also covers every deeper path (`/admin/mail/[id]`). */
  path: string;
  allowed: Pred;
}

const USERS: Pred = tenantRoles(USERS_READ);
const IDENTITY: Pred = tenantRoles(ADMIN_TIER);
const MODULES: Pred = tenantRoles(MODULES_USE);
const SERVICES: Pred = tenantRoles(ADMIN_TIER);
const COMPLIANCE: Pred = tenantRoles(ADMIN_TIER);
// Audit: the endpoint (`resource_activity.yaml` read, admin-identity.controller.ts:614-625) also admits
// plain `member` and `viewer`, because activity read is the generic feed. The page is the admin audit
// trail and its menu gate is admin.access, so it follows the Users tier: nobody is shown a trail they
// were never offered. Mirroring the endpoint exactly would add "member" and "viewer" here.
const AUDIT: Pred = tenantRoles(USERS_READ);
// Mail log: `isElevated` on every route of admin-mail.controller.ts (:78, :113, :169, :233).
const MAIL: Pred = (me) => isElevated(me);
// About: `GET /api/admin/about` is the operator gate (admin-systems.controller.ts:611-613), but the page
// has a local half (the UI build) for every admin.access holder, so it is reachable by them too.
const ABOUT: Pred = (me, t) => isPlatformOperator(me) || tenantRoles(ADMIN_TIER)(me, t);
// Group report (`reports/group-report.controller.ts:46-47`) and rollups (`core.controller.ts:446-475`):
// platform_admin, or the owner of a root company. The menu also needs the ACTIVE company to be a root;
// the page does not, because its own notice ("not a root company") says where to go.
const GROUP: Pred = (me) => isElevated(me) || isRootOwner(me);

/** Settings tabs, in menu order. `/admin` is reachable when any of them is. */
const SETTINGS: readonly AdminRoute[] = [
  { path: "/admin/users", allowed: USERS },
  { path: "/admin/identity", allowed: IDENTITY },
  { path: "/admin/modules", allowed: MODULES },
  { path: "/admin/services", allowed: SERVICES },
  { path: "/admin/compliance", allowed: COMPLIANCE },
  { path: "/admin/audit", allowed: AUDIT },
  { path: "/admin/mail", allowed: MAIL },
  { path: "/admin/about", allowed: ABOUT },
];

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { path: "/admin", allowed: (me, t) => SETTINGS.some((r) => r.allowed(me, t)) },
  ...SETTINGS,
  { path: "/group", allowed: GROUP },
  { path: "/group/reports", allowed: GROUP },
  { path: "/rollups", allowed: GROUP },
  { path: "/systems/bot", allowed: operator },
  { path: "/systems/gateway", allowed: operator },
  { path: "/systems/hub", allowed: operator },
  { path: "/systems/observability", allowed: operator },
  // The workflow list and run history are readable by IT as well as the operator.
  { path: "/systems/automation", allowed: (me, t) => operator(me, t) || anyScopeIt(me, t) },
  // `/systems/github` is deliberately absent: it only redirects to the Web Dev repositories page,
  // which applies its own gate.
];

function normalise(pathname: string): string {
  const bare = pathname.split(/[?#]/)[0] ?? "";
  return bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
}

/** True/false for a route of the Admin area; `undefined` when the table does not know the path. */
export function adminRouteAllowed(pathname: string, me: Me, tenantId: string | null): boolean | undefined {
  const path = normalise(pathname);
  let best: AdminRoute | undefined;
  for (const r of ADMIN_ROUTES) {
    if ((path === r.path || path.startsWith(`${r.path}/`)) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.allowed(me, tenantId) : undefined;
}
