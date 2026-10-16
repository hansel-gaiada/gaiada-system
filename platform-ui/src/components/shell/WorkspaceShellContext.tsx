"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { areaFor, resolveArea, sameArea, type Area } from "@/lib/areas";
import { activeLocation, allRows, applyApprovals, applyRoutes, workspaceForArea, type RoutesRead, type ShellModel, type ShellWorkspace } from "@/lib/shellModel";
import type { RequestRoute } from "@/lib/requests";
import type { ApprovalsRead, ConcreteRow } from "@/lib/workspaceAccess";

// DW-2b: the one place the workspace shell decides where the person is (plan §2.3, §13 trap 2).
//
// The sidebar, the shell's tab strip, the console strips and the breadcrumbs all need the same answer:
// which area, which view, which row and tab hold this page. Computing it in each would let them
// disagree (a strip for one department under another's sidebar), so it is computed here, once, from the
// URL on the CLIENT and the model the server sent. `useWorkspaceShell()` returns null outside the workspace
// shell (the portal, a unit test), which is how a consumer there knows to render plainly.
//
// The last area lives in sessionStorage, so it is per tab and read only after mount; the first render
// uses none, which is what the server rendered too (no hydration mismatch).

const LAST_AREA_KEY = "gaiada.shell.lastArea";

function readLastArea(): Area | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_AREA_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { kind?: unknown; deptId?: unknown; slug?: unknown } | null;
    if (v?.kind === "company") return { kind: "company" };
    if (v?.kind === "admin") return { kind: "admin" };
    if (v?.kind === "workspace") {
      return {
        kind: "workspace",
        ...(typeof v.deptId === "string" ? { deptId: v.deptId } : {}),
        ...(typeof v.slug === "string" ? { slug: v.slug } : {}),
      };
    }
  } catch {
    // Storage blocked, or a hand-edited value: start from home.
  }
  return null;
}

function writeLastArea(area: Area): void {
  try {
    window.sessionStorage.setItem(LAST_AREA_KEY, JSON.stringify(area));
  } catch {
    // Private mode or blocked storage: the sidebar still works, it just forgets on reload.
  }
}

export type ShellView =
  | { kind: "workspace"; ws: ShellWorkspace }
  | { kind: "company" }
  | { kind: "admin" };

/** What to draw for an area. A department the model does not list (another company's id kept from
 *  a previous visit, a unit below a department) falls back to home, never to an empty sidebar. */
export function viewFor(model: ShellModel, area: Area): ShellView {
  if (area.kind === "company") return { kind: "company" };
  if (area.kind === "admin") return { kind: "admin" };
  const ws = workspaceForArea(model, area) ?? model.workspaces.find((w) => w.home) ?? null;
  return ws ? { kind: "workspace", ws } : { kind: "company" };
}

/** An href without its query or fragment: tabs match on the path alone. */
const pathOf = (href: string) => href.split(/[?#]/)[0];

export interface WorkspaceShellValue {
  model: ShellModel;
  pathname: string;
  view: ShellView;
  /** The rows the view draws: a workspace's, or Company's or Admin's with the AI Assistant row first. */
  rows: ConcreteRow[];
  /** The row and tab holding this page (the deepest tab prefix), or null when no row does. */
  active: { rowKey: string; tabKey: string } | null;
  activeRow: ConcreteRow | null;
  /** True when every href is a tab href somewhere in the view's rows. A console strip uses it to hide
   *  itself only where the shell offers every one of its tabs (plan §2.6 rule 1: no page loses its way in). */
  covers: (hrefs: readonly string[]) => boolean;
  /** True when the current page IS a tab of the view (exact path), not a record below one. */
  onToolPage: boolean;
}

const Ctx = createContext<WorkspaceShellValue | null>(null);

/** The workspace shell's state, or null outside the workspace shell. */
export function useWorkspaceShell(): WorkspaceShellValue | null {
  return useContext(Ctx);
}

// DW-9d perf: the pending-approvals count is read AFTER the shell's first byte. The layout builds the model with that read in flight
// (`approvals: "inflight"`: the Approvals row is shown to a person who holds a decide right, hidden from one who does not), streams the
// count in a <Suspense> child (`ShellApprovalsFeed`), and that child hands the settled read to this provider through `ApprovalsSetterCtx`
// (`ShellApprovalsSettle`, an effect). Why an effect and not `use(promise)` in the provider: a suspending provider would hold the whole
// shell behind the read again, which is the thing being removed. The state lives here (not in the feed) so a later server refresh that
// re-renders the layout updates the count in place and the row never falls back to "in flight" once it has resolved.
const ApprovalsSetterCtx = createContext<((read: ApprovalsRead) => void) | null>(null);

/** Renders nothing: hands the layout's settled approvals read to the shell (see above). Rendered by the server's `ShellApprovalsFeed`. */
export function ShellApprovalsSettle({ read }: { read: { pending: number } | null }) {
  const set = useContext(ApprovalsSetterCtx);
  const pending = read ? read.pending : null;
  useEffect(() => {
    set?.(pending === null ? null : { pending });
  }, [set, pending]);
  return null;
}

// DW-10e (BFF §60.9, DW-9 perf): the company's routes are read the same way, and only for a company whose pack does not already have the Requests
// row. The layout starts the read without awaiting it and builds the model with `routes: "inflight"`, which HIDES every routes-gated row and "Ask ..."
// action; `ShellRoutesFeed` (a <Suspense> child) hands the settled read to this provider through `RoutesSetterCtx`, and `applyRoutes` shows them when
// routes exist. A failed read hides them, as an unknown one always did.
const RoutesSetterCtx = createContext<((read: RoutesRead) => void) | null>(null);

/** Renders nothing: hands the layout's settled routes read to the shell. Rendered by the server's `ShellRoutesFeed`. */
export function ShellRoutesSettle({ read }: { read: readonly RequestRoute[] | null }) {
  const set = useContext(RoutesSetterCtx);
  // The server sends a fresh array on every render; settle on its content, so a refresh with the same routes does not set state again.
  const key = read === null ? "null" : JSON.stringify(read);
  useEffect(() => {
    set?.(read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, key]);
  return null;
}

/** Renders no DOM: `.erp-app`'s grid relies on its direct children. */
export function WorkspaceShellProvider({ model: built, children }: { model: ShellModel; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [last, setLast] = useState<Area | null>(null);
  // The model the server built, with the approvals read settled as far as it is known. A model built with a settled read (tests, anything that
  // does not stream it) has no row awaiting it and passes through as is.
  const [approvals, setApprovals] = useState<ApprovalsRead>("inflight");
  const [routes, setRoutes] = useState<RoutesRead>("inflight");
  const model = useMemo(() => applyRoutes(applyApprovals(built, approvals), routes), [built, approvals, routes]);

  useEffect(() => {
    setLast(readLastArea());
  }, []);

  // A workspace, Company or Admin page becomes the new "last" area. Runs after the read above on mount,
  // so the page's own area wins over the stored one.
  useEffect(() => {
    const m = areaFor(pathname);
    if (m.kind !== "workspace" && m.kind !== "company" && m.kind !== "admin") return;
    const a = resolveArea(m, null, model.home);
    writeLastArea(a);
    setLast((prev) => (prev && sameArea(prev, a) ? prev : a));
  }, [pathname, model.home]);

  const area = resolveArea(areaFor(pathname), last, model.home);

  // Cheap (a few dozen rows), so no memo: it follows the pathname and the last area on every render.
  const view = viewFor(model, area);
  // Company and Admin lead with the AI Assistant row (`companyTop`, `adminTop`), as a workspace's top block does.
  const rows = view.kind === "workspace" ? allRows(view.ws) : view.kind === "company" ? [...model.companyTop, ...model.company] : [...model.adminTop, ...model.admin];
  const active = activeLocation(rows, pathname);
  const tabPaths = new Set(rows.flatMap((r) => r.tabs.map((t) => pathOf(t.href))));
  const withheld = new Set(view.kind === "workspace" ? view.ws.withheld : []);
  const value: WorkspaceShellValue = {
    model,
    pathname,
    view,
    rows,
    active,
    activeRow: active ? (rows.find((r) => r.key === active.rowKey) ?? null) : null,
    // A console strip hides when the shell offers every tab the person may USE (§2.6 rule 1). The registry's gated-out tabs
    // (`withheld`) are pages their read gate refuses them, mirroring the server, so they need no second strip to find them.
    covers: (hrefs) => hrefs.every((h) => tabPaths.has(pathOf(h)) || withheld.has(pathOf(h))),
    onToolPage: tabPaths.has(pathOf(pathname)),
  };

  return (
    <ApprovalsSetterCtx.Provider value={setApprovals}>
      <RoutesSetterCtx.Provider value={setRoutes}>
        <Ctx.Provider value={value}>{children}</Ctx.Provider>
      </RoutesSetterCtx.Provider>
    </ApprovalsSetterCtx.Provider>
  );
}
