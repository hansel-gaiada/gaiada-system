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
import { can, canInUnit, isElevated, isLeadOf, leadUnits, unitPathOf, type Capability } from "@/lib/rbac";
import { packFor, ROW_MODULE } from "@/lib/packs";
import { activeCompany, isPlatformOperator, isRootCompany, isRootOwner, moduleOn } from "@/lib/companyContext";
import { gmAccessFor } from "@/lib/gm";
import { deptSlug } from "@/lib/deptToolkits";
import {
  FUNCTIONAL_SLUGS, hrefFor, isPlanned, workspaceBySlug, workspaceFor,
  type Gate, type RowBadge, type Workspace, type WorkspaceRow,
} from "@/lib/workspaces";
import type { IconName } from "@/components/shell/icons";
import type { Area } from "@/lib/areas";

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
  /** The registry keys of the workspaces the active company has a DEPARTMENT for (`workspaceKeysOf`). Read only by the
   *  `hasWorkspace` gate. Absent means "not known", and that gate then hides: it never offers a link to a department the
   *  caller cannot show exists. */
  workspaces?: readonly string[];
  /** What the shell read of the person's pending approvals (`listApprovals`), for the `decider` gate and the row's count
   *  (DW-D23, DW-8m). `pending` is how many wait on THIS person's decision (the items the server marks `decidable`).
   *  `undefined` = the caller did not read approvals (the palette, a test): the gate ALLOWS, so
   *  nothing that was findable stops being findable. `null` = the read was unavailable: the gate ALLOWS too, because a
   *  failed read must never hide the page from a decider. */
  approvals?: { pending: number } | null;
}

/** The decide rights the UI mirrors, any one of which makes the Approvals row worth showing (DW-D23). `approvals.decide`
 *  covers agency approvals, automation and AI actions, pipeline gates and HR/IAM approvals routed through the inbox;
 *  `hr.manage` is what the leave and loan pages already count as "may decide" (`hr/leave/page.tsx`); the two HR approve
 *  rights decide requisitions, offers, payroll and separations. Deliberately left out: rights that decide something that is
 *  never in the Approvals inbox (`invoice.approve`, `work_request.decide`, `search.report.approve`,
 *  `reports.dept_kpi_target.approve`). A mirror, never the authority; the pending-count arm covers what it misses. */
export const DECIDE_CAPABILITIES: readonly Capability[] = [
  "approvals.decide", "hr.manage", "hr.recruitment.approve", "hr.payroll.approve",
];

/** Does the person hold a decide right in ANY company they can reach, or globally? The inbox is cross-company
 *  (`scope=all`), so the active company alone would hide the row from someone who decides in another one. */
function holdsDecideRight(me: Me): boolean {
  return DECIDE_CAPABILITIES.some((cap) => can(me, cap, null) || me.companies.some((c) => can(me, cap, c.id)));
}

/** The `approvals` the gate context takes, from the shell's one read of the pending list: null when the read was
 *  unavailable, else the number of items that wait on this person's own decision. */
export function approvalsGateInput(read: { items: readonly { decidable: boolean }[]; unavailable: boolean }): { pending: number } | null {
  return read.unavailable ? null : { pending: read.items.filter((i) => i.decidable).length };
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
    case "hasWorkspace":
      return ctx.workspaces?.includes(gate.workspace) ?? false;
    case "elevated":
      return isElevated(ctx.me);
    case "platformOperator":
      return isPlatformOperator(ctx.me);
    case "rootGroup":
      return (isRootOwner(ctx.me) || isElevated(ctx.me)) && isRootCompany(company);
    case "decider":
      // Unknown (undefined) and failed (null) reads never hide the row (DW-D23).
      if (ctx.approvals == null) return true;
      return ctx.approvals.pending > 0 || holdsDecideRight(ctx.me);
    case "all":
      return gate.gates.every((g) => gateAllows(g, ctx));
    case "any":
      return gate.gates.some((g) => gateAllows(g, ctx));
  }
}

// ── A functional department's one home ────────────────────────────────────────────────────────────

/** The console root (`/hr`, `/finance`, `/it`) for a department whose NAME slugs to a functional slug,
 *  else null. Since DW-7d these departments are org nodes too, so `/departments/<id>` would be a second
 *  home; the Home page sends it here. Name-keyed like `workspaceFor`, so every company resolves its own node. */
export function functionalConsoleFor(deptName: string): string | null {
  const slug = deptSlug(deptName);
  return FUNCTIONAL_SLUGS.includes(slug) ? `/${slug}` : null;
}

// ── The person's workspaces ───────────────────────────────────────────────────────────────────────

export interface WorkspaceRef {
  workspace: Workspace;
  /** The department's org node id. A functional department (HR, Finance, IT) has one once the company's
   *  tree holds it (DW-7d); null for a company whose tree lacks it, which still gets the workspace. */
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

/** The registry keys of the workspaces the active company has a department for, for the `hasWorkspace` gate: every
 *  department in the org tree (`all` lists the functional ones the tree lacks too, with no `deptId`, and those do not
 *  count: there is no department to send a request to). */
export function workspaceKeysOf(ws: MyWorkspaces): string[] {
  return [...new Set(ws.all.filter((r) => r.deptId !== null).map((r) => r.workspace.key))];
}

/** The active company's department whose workspace is `workspaceKey` (`workspaceFor`, the one name match: the agency
 *  pack's bespoke workspaces only, by the same rule as `toolkitFor`). The first in tree order; null when there is none.
 *  `root` is the org tree, which the caller must have READ: a tree that could not be read is not "no department". */
export function departmentForWorkspace(
  root: OrgTreeNode | null,
  vertical: string | null | undefined,
  workspaceKey: string,
): { id: string; name: string } | null {
  const d = departmentsOf(root).find((n) => workspaceFor(vertical, n.name).key === workspaceKey);
  return d ? { id: d.id, name: d.name } : null;
}

/** The area `resolveArea` (`lib/areas.ts`) falls back to: the home workspace by its department id, or
 *  by its slug when it has no org node yet, else the Company area. */
export function homeArea(home: HomeArea): Area {
  if (home.kind === "company") return { kind: "company" };
  const { workspace, deptId } = home.ref;
  return deptId ? { kind: "workspace", deptId } : { kind: "workspace", slug: workspace.key };
}

// ── What a person is offered ──────────────────────────────────────────────────────────────────────

export interface ConcreteTab { key: string; label: string; href: string; icon: IconName }
export interface ConcreteRow {
  key: string; label: string; icon: IconName; tabs: ConcreteTab[];
  /** The count the sidebar draws after the label (DW-8m). Set only when above 0. */
  count?: number;
}

/** The figure behind a row's badge key, from what the shell read. Add a case when another key is built. */
function badgeCount(badge: RowBadge | undefined, ctx: GateContext): number {
  switch (badge) {
    case "approvals": return ctx.approvals?.pending ?? 0;
    default: return 0;
  }
}

/** The paths (no query) of the tabs `concreteRows` drops for this person BECAUSE OF A GATE: a tab whose own gate fails, and every
 *  tab of a row whose gate fails. A planned (ticketed) tab is "not built", not "not theirs", and a `{dept}` or `{company}` tab with
 *  no id to fill is "not here", so neither counts. The console strips use it (`covers`): a page the person's read gate refuses them
 *  must not keep a second strip on screen. Same gate evaluation as `concreteRows`, never a copy of it. */
export function withheldTabPaths(rows: readonly WorkspaceRow[], ctx: GateContext & { deptId: string | null }): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (isPlanned(row)) continue;
    const rowOpen = gateAllows(row.gate, ctx);
    for (const t of row.tabs) {
      if (isPlanned(t) || (rowOpen && gateAllows(t.gate, ctx))) continue;
      const href = hrefFor(t.href, { deptId: ctx.deptId, companyId: ctx.tenantId });
      if (href) out.add(href.split(/[?#]/)[0]);
    }
  }
  return [...out];
}

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
    if (tabs.length === 0) continue;
    const count = badgeCount(row.badge, ctx);
    out.push({ key: row.key, label: row.label, icon: row.icon, tabs, ...(count > 0 ? { count } : {}) });
  }
  return out;
}
