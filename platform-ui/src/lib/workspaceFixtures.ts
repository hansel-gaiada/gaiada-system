// Test fixtures for the department workspaces (DW-1, DW-2): people, companies and org trees, shared by
// `workspaceAccess.test.ts`, `shellModel.test.ts` and `WorkspaceSidebar.test.tsx`. Pure data, never
// imported by the app. The company names are fixture labels, not real companies (PV-D13).
import type { Me } from "./platform";
import type { OrgTreeNode } from "./workspaceAccess";

export type Company = Me["companies"][number];
export const AGENCY: Company = { id: "co-a", name: "Agency", type: null, vertical: "agency", rootCompanyId: "co-root" };
export const ROOT: Company = { id: "co-root", name: "Holding", type: null, vertical: "holding", rootCompanyId: "co-root" };
export const HOTEL: Company = { id: "co-h", name: "Hotel", type: null, vertical: "hospitality", rootCompanyId: "co-root" };

export function me(roles: Me["roles"], companies: Company[] = [AGENCY], extra: Partial<Me> = {}): Me {
  return { userId: "u-1", name: "U", email: "u@x.test", title: null, assurance: "high", companies, roles, ...extra };
}
export const member = (co = "co-a") => ({ role: "member", scopeType: "company", scopeId: co });
export const lead = (unit: string) => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit });

export const node = (id: string, name: string, kind: string, children: OrgTreeNode[] = [], assigneeId?: string): OrgTreeNode =>
  ({ id, name, kind, children, ...(assigneeId ? { assigneeId } : {}) });
export const person = (id: string, userId: string) => node(id, userId, "person", [], userId);

/** An agency company: GM, Web Dev (with a Frontend division), SEO. HR, IT and Finance are not in the tree. */
export function agencyTree(placements: { web?: string[]; frontend?: string[]; seo?: string[] } = {}): OrgTreeNode {
  return node("root", "Agency", "company", [
    node("d-web", "Web Dev", "department", [
      node("dv-fe", "Frontend", "division", (placements.frontend ?? []).map((u, i) => person(`p-fe-${i}`, u))),
      ...(placements.web ?? []).map((u, i) => person(`p-web-${i}`, u)),
    ]),
    node("d-seo", "SEO", "department", (placements.seo ?? []).map((u, i) => person(`p-seo-${i}`, u))),
    node("d-gm", "GM", "department"),
  ]);
}
