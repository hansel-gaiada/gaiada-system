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
import { ADMIN_ROWS, ASSISTANT_ROW, COMPANY_ROWS, hrefFor, isPlanned, sidebarRows, type WorkspaceKind } from "@/lib/workspaces";
import { can } from "@/lib/rbac";
import type { RequestRoute } from "@/lib/requests";
import { routeAskLabel, routeHref } from "@/lib/requests";
import { concreteRows, gateAllows, homeArea, routeActionsFor, withheldTabPaths, workspaceKeysOf, type ApprovalsRead, type ConcreteRow, type GateContext, type MyWorkspaces, type WorkspaceRef } from "@/lib/workspaceAccess";
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
  /** The AI Assistant row that leads the Company area's menu, above its own rows. A workspace's menu has it in its `top` block; the
   *  Company and Admin areas draw no workspace, and with the floating button gone (DW-D38) they would offer no assistant at all.
   *  Kept apart from `company` so that list stays the area's own rows (the footer link and the home fallback read its first tab). */
  companyTop: ConcreteRow[];
  /** The same row for the Admin area. */
  adminTop: ConcreteRow[];
  /** Set only on a model built with `routes: "inflight"`: the person may send across (`work_request.send_across`), so `applyRoutes` adds one
   *  "Ask ..." create per route once the read settles. */
  awaitsRoutes?: { canSend: boolean };
  home: Area;
  homeLabel: string;
  /** Where "Back to <home>" goes: the home workspace's Overview, or the first Company row. */
  homeHref: string | null;
}

const idOf = (ref: WorkspaceRef) => ref.deptId ?? `slug:${ref.workspace.key}`;

export function buildShellModel(input: {
  me: Me; tenantId: string | null; workspaces: MyWorkspaces;
  /** The shell's one read of the pending approvals (`approvalsGateInput`), for the Approvals row's gate and count (DW-8m).
   *  Omitted or null leaves the row shown with no count. `"inflight"` (the layout, which does not wait for the read) leaves the rows that
   *  depend on it marked `awaitsApprovals`, and `applyApprovals` settles them on the client once the count streams in. */
  approvals?: GateContext["approvals"];
  /** The active company's routes to other group companies (`GET requests/routes`, DW-10e), for the `hasRoutes` gate and the per-route
   *  "Ask ..." actions. Omitted or null (unread, failed) offers none of them. */
  routes?: GateContext["routes"];
}): ShellModel {
  const { me, tenantId, workspaces, approvals, routes } = input;
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
    const ctx = { me, tenantId, unitPath: ref.unitPath, deptId: ref.deptId, workspaces: departments, approvals, routes };
    const raw = sidebarRows(ref.workspace);
    const creates = ref.workspace.creates.flatMap((key) => {
      const action = ref.workspace.quickActions.find((a) => a.key === key);
      if (!action || isPlanned(action) || !gateAllows(action.gate, ctx)) return [];
      const href = hrefFor(action.href, { deptId: ref.deptId, companyId: tenantId });
      return href ? [{ label: action.label, href }] : [];
    });
    // DW-10e (§60.9): one create per active route, beside the same-company ones.
    for (const a of routeActionsFor(ctx)) creates.push({ label: a.label, href: a.href });
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
  const flat = { me, tenantId, unitPath: [] as string[], deptId: null, workspaces: departments, approvals, routes };
  const company = concreteRows(COMPANY_ROWS, flat);
  const admin = concreteRows(ADMIN_ROWS, flat);
  const companyTop = concreteRows([ASSISTANT_ROW], flat);
  const adminTop = concreteRows([ASSISTANT_ROW], flat);

  const home = homeArea(workspaces.home);
  const homeWs = out.find((w) => w.home) ?? null;
  return {
    workspaces: out,
    company,
    admin,
    companyTop,
    adminTop,
    home,
    homeLabel: homeWs?.label ?? "Company",
    homeHref: homeWs ? overviewHref(homeWs) : (company[0]?.tabs[0]?.href ?? null),
    ...(routes === "inflight" ? { awaitsRoutes: { canSend: can(me, "work_request.send_across", tenantId) } } : {}),
  };
}

// ── The routes read, settled after the first byte (DW-9 perf; BFF §60.9) ──────────────────────────

/** What the shell knows of the company's routes once the streamed read resolves: the list, `null` when it failed, `"inflight"` before. */
export type RoutesRead = readonly RequestRoute[] | null | "inflight";

/** Settles a model built with `routes: "inflight"`. Unlike the approvals row (shown to a decider while in flight), everything the routes gate
 *  is HIDDEN until the read resolves: a row marked `awaitsRoutes` is dropped (its tabs' paths join the workspace's `withheld`, as a gate would
 *  have), and no "Ask ..." create is offered. Resolved with routes: the rows stay and each workspace gets one create per route (for a person
 *  who may send across). Resolved with none, or failed (`null`): the rows stay hidden, which is the "a failure hides" rule. Pure; a model that
 *  awaits no routes is returned as is. */
export function applyRoutes(model: ShellModel, read: RoutesRead): ShellModel {
  if (!model.awaitsRoutes) return model;
  const routes = Array.isArray(read) ? (read as readonly RequestRoute[]) : [];
  const keep = routes.length > 0;
  const settle = (rows: ConcreteRow[], hidden: string[]): ConcreteRow[] => {
    if (!rows.some((r) => r.awaitsRoutes)) return rows;
    const out: ConcreteRow[] = [];
    for (const row of rows) {
      if (!row.awaitsRoutes) { out.push(row); continue; }
      if (!keep) { for (const t of row.tabs) hidden.push(t.href.split(/[?#]/)[0]); continue; }
      const { awaitsRoutes: _wait, ...rest } = row;
      out.push(rest);
    }
    return out;
  };
  const creates = keep && model.awaitsRoutes.canSend ? routes.map((r) => ({ label: routeAskLabel(r), href: routeHref(r.routeId) })) : [];
  const workspaces = model.workspaces.map((ws) => {
    const hidden: string[] = [];
    const rows = { top: settle(ws.rows.top, hidden), work: settle(ws.rows.work, hidden), performance: settle(ws.rows.performance, hidden), you: settle(ws.rows.you, hidden) };
    return { ...ws, rows, creates: [...ws.creates, ...creates], withheld: hidden.length ? [...new Set([...ws.withheld, ...hidden])] : ws.withheld };
  });
  const { awaitsRoutes: _done, ...rest } = model;
  return { ...rest, workspaces };
}

// ── The approvals read, settled after the first byte (DW-9d perf) ─────────────────────────────────

/** Settles the rows a model built with `approvals: "inflight"` marked `awaitsApprovals`, for what is now known of the pending read.
 *  DW-D23, exactly, with the one new state (the count still in flight):
 *   - in flight: the row is shown to a person who holds a decide right (no badge yet) and hidden from one who does not;
 *   - resolved: shown when `pending > 0` or the person holds a decide right, with the pending count as its badge when above 0;
 *   - unavailable (`null`): shown, no badge: a failed read never hides it.
 *  A row it hides has its tabs' paths added to the workspace's `withheld`, as `concreteRows`'s own gate would have. Pure: the model is
 *  returned as is when nothing awaits, so a model built with a settled read (a test, the palette) passes through untouched. */
export function applyApprovals(model: ShellModel, read: ApprovalsRead): ShellModel {
  let touched = false;
  const settle = (rows: ConcreteRow[], hidden: string[]): ConcreteRow[] => {
    if (!rows.some((r) => r.awaitsApprovals)) return rows;
    touched = true;
    const out: ConcreteRow[] = [];
    for (const row of rows) {
      const { awaitsApprovals: wait, ...rest } = row;
      if (!wait) { out.push(row); continue; }
      const shown = read === "inflight" ? wait.decider : read === null ? true : read.pending > 0 || wait.decider;
      if (!shown) { for (const t of row.tabs) hidden.push(t.href.split(/[?#]/)[0]); continue; }
      const count = wait.badge && read !== null && read !== "inflight" && read.pending > 0 ? read.pending : undefined;
      out.push(count ? { ...rest, count } : rest);
    }
    return out;
  };
  const noHidden: string[] = [];
  const workspaces = model.workspaces.map((ws) => {
    const hidden: string[] = [];
    const rows = {
      top: settle(ws.rows.top, hidden), work: settle(ws.rows.work, hidden),
      performance: settle(ws.rows.performance, hidden), you: settle(ws.rows.you, hidden),
    };
    return hidden.length === 0 && rows.top === ws.rows.top && rows.work === ws.rows.work && rows.performance === ws.rows.performance && rows.you === ws.rows.you
      ? ws
      : { ...ws, rows, withheld: [...new Set([...ws.withheld, ...hidden])] };
  });
  const company = settle(model.company, noHidden);
  const admin = settle(model.admin, noHidden);
  const companyTop = settle(model.companyTop, noHidden);
  const adminTop = settle(model.adminTop, noHidden);
  return touched ? { ...model, workspaces, company, admin, companyTop, adminTop } : model;
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
