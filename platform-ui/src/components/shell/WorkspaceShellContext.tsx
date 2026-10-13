"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { areaFor, resolveArea, sameArea, type Area } from "@/lib/areas";
import { activeLocation, allRows, workspaceForArea, type ShellModel, type ShellWorkspace } from "@/lib/shellModel";
import type { ConcreteRow } from "@/lib/workspaceAccess";

// DW-2b: the one place the workspace shell decides where the person is (plan §2.3, §13 trap 2).
//
// The sidebar, the shell's tab strip, the console strips and the breadcrumbs all need the same answer:
// which area, which view, which row and tab hold this page. Computing it in each would let them
// disagree (a strip for one department under another's sidebar), so it is computed here, once, from the
// URL on the CLIENT and the model the server sent. `useWorkspaceShell()` returns null in the classic
// shell, which is how every consumer knows to render exactly as it always did.
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
  /** The rows the view draws: a workspace's, Company's or Admin's. */
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

/** The workspace shell's state, or null in the classic shell. */
export function useWorkspaceShell(): WorkspaceShellValue | null {
  return useContext(Ctx);
}

/** Renders no DOM: `.erp-app`'s grid relies on its direct children. */
export function WorkspaceShellProvider({ model, children }: { model: ShellModel; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [last, setLast] = useState<Area | null>(null);

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
  const rows = view.kind === "workspace" ? allRows(view.ws) : view.kind === "company" ? model.company : model.admin;
  const active = activeLocation(rows, pathname);
  const tabPaths = new Set(rows.flatMap((r) => r.tabs.map((t) => pathOf(t.href))));
  const value: WorkspaceShellValue = {
    model,
    pathname,
    view,
    rows,
    active,
    activeRow: active ? (rows.find((r) => r.key === active.rowKey) ?? null) : null,
    covers: (hrefs) => hrefs.every((h) => tabPaths.has(pathOf(h))),
    onToolPage: tabPaths.has(pathOf(pathname)),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
