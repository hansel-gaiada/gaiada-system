// What the staff menu, the org tree and the toolkits need to know about the ACTIVE company and about
// who the person is relative to the group's root (PV1-04). Pure and client-safe: no server-only
// imports, so `nav.ts`, the sidebar and the server pages can all share it.
//
// None of this is a security boundary. The server gates every route; these helpers only decide what
// is worth showing.
import type { Me } from "./platform";
import { isElevated } from "./rbac";

export type MeCompany = Me["companies"][number];

/** The company the person is working in: the one matching `tenantId`, else the first they can see. */
export function activeCompany(me: Me, tenantId?: string | null): MeCompany | undefined {
  return me.companies.find((c) => c.id === tenantId) ?? me.companies[0];
}

/** A root company is its own root (PV-D20). A missing `rootCompanyId` (older backend) is "not a root". */
export function isRootCompany(company: MeCompany | undefined): boolean {
  return !!company && company.rootCompanyId === company.id;
}

/** PV-D20: holds the `owner` role, company-scoped, on a company that is a root. Owning a child
 *  company does not make anyone an owner of the group. */
export function isRootOwner(me: Me): boolean {
  const roots = new Set(me.companies.filter((c) => isRootCompany(c)).map((c) => c.id));
  return me.roles.some((r) => r.role === "owner" && r.scopeType === "company" && r.scopeId != null && roots.has(r.scopeId));
}

/** PV-D18: the Platform surfaces (bot, gateway, hub, automation, observability) are for
 *  `platform_admin` at global scope and for the owner of the root. */
export function isPlatformOperator(me: Me): boolean {
  return isElevated(me) || isRootOwner(me);
}

/** A module is on unless the company says otherwise. A missing `enabledModules` means "unknown", and
 *  unknown hides nothing. */
export function moduleOn(company: MeCompany | undefined, key: string): boolean {
  if (!company || !company.enabledModules) return true;
  return company.enabledModules.includes(key);
}
