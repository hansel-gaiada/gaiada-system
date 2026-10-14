// The workspace shell's model (DW-2a, docs/plans/2026-10-13-department-workspaces.md §2.2–2.3).
//
// The server resolves the person's workspaces (`lib/workspaces-data.ts`) and turns them into this plain,
// serialisable model: every workspace the switcher can open, each with its rows already gated and made
// concrete, plus the Company and Admin rows. The client sidebar then picks the area from `usePathname()`
// and draws one of them. Choosing on the client is the point (plan §13 trap 2): a layout gets no
// pathname, so a server-chosen sidebar would flash the wrong department.
//
// Pure and client-safe, like the registry it reads. Gates mirror the server; they are not security.
import type { Me } from "@/lib/platform";
import { ADMIN_ROWS, COMPANY_ROWS, hrefFor, isPlanned, sidebarRows, type WorkspaceKind } from "@/lib/workspaces";
import { concreteRows, gateAllows, homeArea, withheldTabPaths, workspaceKeysOf, type ConcreteRow, type GateContext, type MyWorkspaces, type WorkspaceRef } from "@/lib/workspaceAccess";
import type { Area } from "@/lib/areas";

export interface ShellRows {
  /** Overview and AI Assistant. */
  top: ConcreteRow[];
  work: ConcreteRow[];
  performance: ConcreteRow[];
  you: ConcreteRow[];
}

export interface ShellWorkspace {
  /** Stable across renders: the department's org node id, or `slug:<key>` without an org node. */
  id: string;
  key: string;
  label: string;
  kind: WorkspaceKind;
  deptId: string | null;
  /** One of the person's own workspaces (`mine`). */
  mine: boolean;
  home: boolean;
  lead: boolean;
  /** The workspace's own create actions, planned and gated ones dropped, made concrete (DW-2f). */
  creates: { label: string; href: string }[];
  rows: ShellRows;
  /** The paths of the registry tabs this person is not offered because a gate refuses them (`withheldTabPaths`), so a console
   *  strip can tell "the shell lacks this tab" from "this page is not theirs". */
  withheld: string[];
}

export interface ShellModel {
  /** The person's own (home first), then every other department of the active company. */
  workspaces: ShellWorkspace[];
  company: ConcreteRow[];
  admin: ConcreteRow[];
  home: Area;
  homeLabel: string;
  /** Where "Back to <home>" goes: the home workspace's Overview, or the first Company row. */
  homeHref: string | null;
}

const idOf = (ref: WorkspaceRef) => ref.deptId ?? `slug:${ref.workspace.key}`;

export function buildShellModel(input: {
  me: Me; tenantId: string | null; workspaces: MyWorkspaces;
  /** The shell's one read of the pending approvals (`approvalsGateInput`), for the Approvals row's gate and count (DW-8m).
   *  Omitted or null leaves the row shown with no count. */
  approvals?: GateContext["approvals"];
}): ShellModel {
  const { me, tenantId, workspaces, approvals } = input;
  const homeRef = workspaces.home.kind === "workspace" ? workspaces.home.ref : null;
  // Which departments this company has, for the `hasWorkspace` gate (DW-5f: "Ask Creatives" needs a Creatives).
  const departments = workspaceKeysOf(workspaces);

  const seen = new Set<string>();
  const out: ShellWorkspace[] = [];
  const add = (ref: WorkspaceRef, mine: boolean) => {
    // Same workspace and department = the same entry. `mine` wins because it is added first.
    const dedupe = `${ref.workspace.key}:${ref.deptId ?? ""}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const ctx = { me, tenantId, unitPath: ref.unitPath, deptId: ref.deptId, workspaces: departments, approvals };
    const raw = sidebarRows(ref.workspace);
    const creates = ref.workspace.creates.flatMap((key) => {
      const action = ref.workspace.quickActions.find((a) => a.key === key);
      if (!action || isPlanned(action) || !gateAllows(action.gate, ctx)) return [];
      const href = hrefFor(action.href, { deptId: ref.deptId, companyId: tenantId });
      return href ? [{ label: action.label, href }] : [];
    });
    out.push({
      id: idOf(ref),
      key: ref.workspace.key,
      label: ref.workspace.label,
      kind: ref.workspace.kind,
      deptId: ref.deptId,
      mine,
      home: !!homeRef && homeRef.workspace.key === ref.workspace.key && homeRef.deptId === ref.deptId,
      lead: ref.lead,
      creates,
      rows: {
        top: concreteRows(raw.top, ctx),
        work: concreteRows(raw.work, ctx),
        performance: concreteRows(raw.performance, ctx),
        you: concreteRows(raw.you, ctx),
      },
      withheld: withheldTabPaths([...raw.top, ...raw.work, ...raw.performance, ...raw.you], ctx),
    });
  };
  for (const ref of workspaces.mine) add(ref, true);
  for (const ref of workspaces.all) add(ref, false);

  // The Company and Admin areas belong to no department.
  const flat = { me, tenantId, unitPath: [] as string[], deptId: null, workspaces: departments, approvals };
  const company = concreteRows(COMPANY_ROWS, flat);
  const admin = concreteRows(ADMIN_ROWS, flat);

  const home = homeArea(workspaces.home);
  const homeWs = out.find((w) => w.home) ?? null;
  return {
    workspaces: out,
    company,
    admin,
    home,
    homeLabel: homeWs?.label ?? "Company",
    homeHref: homeWs ? overviewHref(homeWs) : (company[0]?.tabs[0]?.href ?? null),
  };
}

// ── Helpers the client sidebar uses (and the tests pin) ───────────────────────────────────────────

/** The workspace an area draws: by department id, else by slug (the person's own first, because the
 *  list puts them first). Null when the area is not a workspace or names a department not listed. */
export function workspaceForArea(model: ShellModel, area: Area): ShellWorkspace | null {
  if (area.kind !== "workspace") return null;
  if (area.deptId !== undefined) return model.workspaces.find((w) => w.deptId === area.deptId) ?? null;
  if (area.slug !== undefined) return model.workspaces.find((w) => w.key === area.slug) ?? null;
  return null;
}

/** A workspace's Overview link: where the switcher sends you. */
export function overviewHref(ws: ShellWorkspace): string | null {
  return ws.rows.top.find((r) => r.key === "overview")?.tabs[0]?.href ?? null;
}

/** Every row of a workspace, in sidebar order. */
export function allRows(ws: ShellWorkspace): ConcreteRow[] {
  return [...ws.rows.top, ...ws.rows.work, ...ws.rows.performance, ...ws.rows.you];
}

/** The active row and tab for a pathname: the tab whose href is the deepest prefix of the path, the same
 *  rule as `SectionTabs`, so a sub-route lights its parent tab. A query string never counts. */
export function activeLocation(rows: readonly ConcreteRow[], pathname: string): { rowKey: string; tabKey: string } | null {
  const path = pathname.split(/[?#]/)[0];
  let best: { rowKey: string; tabKey: string; len: number } | null = null;
  for (const row of rows) {
    for (const tab of row.tabs) {
      const href = tab.href.split(/[?#]/)[0];
      // "/" is exact only, or it would be the prefix of every page.
      const hit = path === href || (href !== "/" && path.startsWith(`${href}/`));
      if (hit && (!best || href.length > best.len)) best = { rowKey: row.key, tabKey: tab.key, len: href.length };
    }
  }
  return best ? { rowKey: best.rowKey, tabKey: best.tabKey } : null;
}
