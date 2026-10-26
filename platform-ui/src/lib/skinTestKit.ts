// Shared setup for the suites that must hold in BOTH skins (SCP-Kf, DW-D51, plan §6.1, §8): not a test itself, and never imported by the app.
//
// A skin changes look and arrangement only, so every invariant the Standard shell keeps (the palette finds everything, every page has one area,
// nothing loses its home, the sidebar keeps its fixed items) must hold when a workspace wears the Social skin. `SKIN_RUNS` names the two ways a
// model is built, and `SKIN_PERSONAS` the people to build it for: a Social Media employee, its head, the group's head (a lead of the root), a
// company admin placed in Social, an unplaced platform admin who only visits it, and a Web Dev employee in whose company Social exists.
import type { Me } from "./platform";
import { buildShellModel, type ShellModel } from "./shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import type { SkinKey } from "./skins";
import { AGENCY, ROOT, lead, me, member, node, person } from "./workspaceFixtures";

export type SkinsInput = { on: SkinKey[]; choice?: "workspace" | "standard" } | undefined;

/** How a model is built: no skin switched on (every workspace Standard), and Social switched on (Social Media wears it). */
export const SKIN_RUNS: readonly { name: string; skins: SkinsInput }[] = [
  { name: "Standard skin", skins: undefined },
  { name: "Social skin", skins: { on: ["standard", "social"] } },
];

/** An agency with GM, Web Dev, SEO and Social Media departments; `u-1` is seated where `placed` says (or nowhere). */
export function agencyWithSocial(placed: "social" | "web" | null): OrgTreeNode {
  return node("root", "Agency", "company", [
    node("d-gm", "GM", "department"),
    node("d-web", "Web Dev", "department", placed === "web" ? [person("p-web-0", "u-1")] : []),
    node("d-seo", "SEO", "department"),
    node("d-soc", "Social Media", "department", placed === "social" ? [person("p-soc-0", "u-1")] : []),
  ]);
}

export interface SkinPersona { name: string; who: Me; tenantId: string; root: OrgTreeNode }

const companyAdmin = { role: "company_admin", scopeType: "company", scopeId: "co-a" };

export const SKIN_PERSONAS: readonly SkinPersona[] = [
  { name: "a placed Social Media employee", who: me([member()]), tenantId: "co-a", root: agencyWithSocial("social") },
  { name: "the head of Social Media", who: me([member(), lead("d-soc")]), tenantId: "co-a", root: agencyWithSocial("social") },
  { name: "a lead of the company root, placed in Social Media", who: me([member(), lead("root")]), tenantId: "co-a", root: agencyWithSocial("social") },
  { name: "a company admin placed in Social Media", who: me([member(), companyAdmin]), tenantId: "co-a", root: agencyWithSocial("social") },
  {
    name: "an unplaced platform admin, who only visits Social Media",
    who: me([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }], [ROOT, AGENCY]),
    tenantId: "co-a", root: agencyWithSocial(null),
  },
  { name: "a placed Web Dev employee (Social Media exists in their company)", who: me([member()]), tenantId: "co-a", root: agencyWithSocial("web") },
];

/** The shell model for a persona, as the layout builds it. */
export function modelFor(p: SkinPersona, skins: SkinsInput): ShellModel {
  return buildShellModel({
    me: p.who, tenantId: p.tenantId, workspaces: resolveMyWorkspaces({ me: p.who, tenantId: p.tenantId, root: p.root }),
    ...(skins ? { skins } : {}),
  });
}

/** Every concrete tab href of a workspace's rows, in sidebar order. */
export function tabHrefsOf(ws: ShellModel["workspaces"][number]): string[] {
  return [...ws.rows.top, ...ws.rows.work, ...ws.rows.performance, ...ws.rows.you].flatMap((r) => r.tabs.map((t) => t.href));
}
