// The strip on Me's own pages (DW-8d). It is the registry's Me row, so it can never drift from the sidebar:
// the same tabs, the same gates (`concreteRows` applies `gateAllows`), the same order. Pure and client-safe.
import { YOU_ROWS } from "@/lib/workspaces";
import { concreteRows, type ConcreteTab, type GateContext } from "@/lib/workspaceAccess";

/** The Me row's tabs this person may be offered: Summary, Leave, Loans, Pay, Timesheet (only where the
 *  company has timesheets) and Account. */
export function meStripTabs(ctx: GateContext): ConcreteTab[] {
  const me = YOU_ROWS.filter((r) => r.key === "me");
  return concreteRows(me, { ...ctx, unitPath: [], deptId: null })[0]?.tabs ?? [];
}

/** Does the strip show on this page? Exactly `/me`, or at or under one of the other tabs. `/me/inbox`,
 *  `/me/tasks` and `/me/learning` sit under the same layout but are not Me tabs, so no strip there. */
export function showMeStrip(pathname: string, tabs: readonly { href: string }[]): boolean {
  const path = pathname.split(/[?#]/)[0];
  if (path === "/me") return true;
  return tabs.some((t) => t.href !== "/me" && (path === t.href || path.startsWith(`${t.href}/`)));
}
