// Which workspaces a person has, and what of each they may be offered (DW-1b). Pure and client-safe,
// like the registry it reads (`lib/workspaces.ts`). `lib/workspaces-data.ts` feeds it on the server.
//
// Home (plan §2.1), in this order:
//   1. the person's primary placement in the active company's org tree (the first person node that is
//      them, in the same walk order as `myPlacement`);
//   2. a unit they lead (`org_unit_lead`), as the department that holds it;
//   3. a functional role in this company: HR (`hr_*`), Finance (`finance_*`) or IT (`it*`), or a
//      shared-service scope serving this company for that module;
//   4. GM access, full or narrowed (`lib/gm.ts`), when the company has an Office of the GM;
//   5. otherwise the Company area.
// Other placements, led units and functional roles add workspaces to the switcher. Every department of
// the active company is listed too, ungated, because hiding one would lie about the org chart (GM-01).
//
// Nothing here is a security boundary. `gateAllows` mirrors nav.ts and the consoles; the server
// refuses everything it must, and every read is narrowed there.
import type { Me } from "@/lib/platform";
import { can, canInUnit, isElevated, isLeadOf, leadUnits, unitPathOf } from "@/lib/rbac";
import { packFor, ROW_MODULE } from "@/lib/packs";
import { activeCompany, isPlatformOperator, isRootCompany, isRootOwner, moduleOn } from "@/lib/companyContext";
import { gmAccessFor } from "@/lib/gm";
import { deptSlug } from "@/lib/deptToolkits";
import {
  FUNCTIONAL_SLUGS, hrefFor, isPlanned, workspaceBySlug, workspaceFor,
  type Gate, type Workspace, type WorkspaceRow,
} from "@/lib/workspaces";
import type { IconName } from "@/components/shell/icons";

/** The parts of an org node this file reads (`lib/org.ts`'s `OrgNode`, which is server-only). */
export interface OrgTreeNode {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string | null;
  children: readonly OrgTreeNode[];
}

export interface GateContext {
  me: Me;
  tenantId: string | null;
  /** The workspace's unit and its ancestors, nearest first; [] when it has no org node. */
  unitPath: readonly string[];
}

/** Evaluate a registry gate. Mirrors the surface each gate was copied from; see `Gate`'s doc. */
export function gateAllows(gate: Gate | undefined, ctx: GateContext): boolean {
  if (!gate) return true;
  const company = activeCompany(ctx.me, ctx.tenantId);
  switch (gate.kind) {
    case "cap":
      return can(ctx.me, gate.cap, ctx.tenantId);
    case "unitCap":
      return canInUnit(ctx.me, gate.cap, ctx.tenantId, ctx.unitPath);
    case "agencyRow": {
      // nav.ts's `agencyRow`: listed by the company's pack, and its module (if any) on.
      if (!packFor(company?.vertical).agencyRows.includes(gate.row)) return false;
      const mod = ROW_MODULE[gate.row];
      return !mod || moduleOn(company, mod);
    }
    case "pack":
      return packFor(company?.vertical).key === gate.pack;
    case "module":
      return moduleOn(company, gate.module);
    case "elevated":
      return isElevated(ctx.me);
    case "platformOperator":
      return isPlatformOperator(ctx.me);
    case "rootGroup":
      return (isRootOwner(ctx.me) || isElevated(ctx.me)) && isRootCompany(company);
    case "all":
      return gate.gates.every((g) => gateAllows(g, ctx));
    case "any":
      return gate.gates.some((g) => gateAllows(g, ctx));
  }
}

// ── The person's workspaces ───────────────────────────────────────────────────────────────────────

export interface WorkspaceRef {
  workspace: Workspace;
  /** The department's org node id. Null for a functional department not in the org tree yet (DW-7d). */
  deptId: string | null;
  /** The unit and its ancestors, nearest first, for unit-scoped gates. [] without an org node. */
  unitPath: readonly string[];
  /** Leads this department or an ancestor of it: heads get Me | Team (DW-D8). */
  lead: boolean;
}

export type HomeArea = { kind: "workspace"; ref: WorkspaceRef } | { kind: "company" };

export interface MyWorkspaces {
  home: HomeArea;
  /** The person's own workspaces, home first. */
  mine: readonly WorkspaceRef[];
  /** Every department of the active company for the switcher: the Office of the GM first, then the org
   *  tree's order, then HR, IT and Finance when the tree does not hold them. */
  all: readonly WorkspaceRef[];
}

/** Roles that make someone staff of a functional department in the company they are granted in. */
const FUNCTIONAL_ROLES: Record<string, readonly string[]> = {
  hr: ["hr_staff", "hr_manager"],
  finance: ["finance_staff", "finance_manager"],
  it: ["it", "it_admin", "it_manager"],
};

function departmentsOf(root: OrgTreeNode | null): OrgTreeNode[] {
  return root ? root.children.filter((c) => c.kind === "department") : [];
}

/** The department nodes the person sits in, anywhere below them, in tree order. The first is the
 *  department `myPlacement` reports. */
function placements(depts: readonly OrgTreeNode[], userId: string): OrgTreeNode[] {
  const holds = (n: OrgTreeNode): boolean => n.children.some((c) => (c.kind === "person" && c.assigneeId === userId) || holds(c));
  return depts.filter(holds);
}

/** Does this grant set give the person a functional role in this company? */
function holdsFunctional(me: Me, tenantId: string | null, slug: string): boolean {
  if (!tenantId) return false;
  const roles = FUNCTIONAL_ROLES[slug] ?? [];
  const granted = me.roles.some((g) => roles.includes(g.role) && (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenantId)));
  const served = (me.serviceScopes ?? []).some((s) => s.companyId === tenantId && s.module === slug);
  return granted || served;
}

export function resolveMyWorkspaces(input: { me: Me; tenantId: string | null; root: OrgTreeNode | null }): MyWorkspaces {
  const { me, tenantId, root } = input;
  const vertical = activeCompany(me, tenantId)?.vertical;
  const depts = departmentsOf(root);

  const refFor = (d: OrgTreeNode): WorkspaceRef => {
    const unitPath = root ? unitPathOf(root, d.id) : [d.id];
    return { workspace: workspaceFor(vertical, d.name), deptId: d.id, unitPath, lead: isLeadOf(me, unitPath) };
  };
  const bySlug = (slug: string): WorkspaceRef => {
    const node = depts.find((d) => deptSlug(d.name) === slug);
    return node ? refFor(node) : { workspace: workspaceBySlug(slug)!, deptId: null, unitPath: [], lead: false };
  };

  // Every department, GM first (nav.ts's GM-01/OQ-4 order), then functional ones the tree lacks.
  const isGm = (d: OrgTreeNode) => workspaceFor(vertical, d.name).kind === "office";
  const all: WorkspaceRef[] = [...depts.filter(isGm), ...depts.filter((d) => !isGm(d))].map(refFor);
  for (const slug of ["hr", "it", "finance"]) {
    if (!all.some((r) => r.workspace.key === slug)) all.push(bySlug(slug));
  }

  // The person's own, in home-precedence order.
  const own: WorkspaceRef[] = placements(depts, me.userId).map(refFor);
  for (const d of depts) {
    // A led unit adds the department that holds it (the unit may be the department or below it).
    if (leadUnits(me).some((unit) => unitPathOf(d, unit).length > 0)) own.push(refFor(d));
  }
  for (const slug of FUNCTIONAL_SLUGS) if (holdsFunctional(me, tenantId, slug)) own.push(bySlug(slug));
  const gm = all.find((r) => r.workspace.kind === "office");
  const gmAccess = gmAccessFor(me, tenantId);
  if (gm && (gmAccess === "full" || (own.length === 0 && gmAccess === "narrowed"))) own.push(gm);

  const mine: WorkspaceRef[] = [];
  for (const r of own) if (!mine.some((m) => m.workspace.key === r.workspace.key && m.deptId === r.deptId)) mine.push(r);
  const home: HomeArea = mine.length > 0 ? { kind: "workspace", ref: mine[0] } : { kind: "company" };
  return { home, mine, all };
}

// ── What a person is offered ──────────────────────────────────────────────────────────────────────

export interface ConcreteTab { key: string; label: string; href: string; icon: IconName }
export interface ConcreteRow { key: string; label: string; icon: IconName; tabs: ConcreteTab[] }

/** Rows as the person may be offered them: planned items dropped (unless `includePlanned`, for sizing),
 *  gates applied, `{dept}`/`{company}` filled, and a row left with no tab dropped. */
export function concreteRows(
  rows: readonly WorkspaceRow[],
  ctx: GateContext & { deptId: string | null },
  opts: { includePlanned?: boolean } = {},
): ConcreteRow[] {
  const out: ConcreteRow[] = [];
  for (const row of rows) {
    if ((!opts.includePlanned && isPlanned(row)) || !gateAllows(row.gate, ctx)) continue;
    const tabs: ConcreteTab[] = [];
    for (const t of row.tabs) {
      if ((!opts.includePlanned && isPlanned(t)) || !gateAllows(t.gate, ctx)) continue;
      const href = hrefFor(t.href, { deptId: ctx.deptId, companyId: ctx.tenantId });
      if (href) tabs.push({ key: t.key, label: t.label, href, icon: t.icon });
    }
    if (tabs.length > 0) out.push({ key: row.key, label: row.label, icon: row.icon, tabs });
  }
  return out;
}
