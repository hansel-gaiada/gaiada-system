import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import { getPrefs } from "@/lib/prefs";
import { moduleGate } from "@/lib/modules";
import { myWorkspaces } from "@/lib/workspaces-data";
import { routesForShell } from "@/lib/requests-data";
import { needsRoutesRead } from "@/lib/workspaceAccess";
import { parseOverviewPeriod, subjectOfRef, workspaceRefForPage } from "@/lib/overview";
import { canSwitchToTeam, resolveOverviewView } from "@/lib/overviewTeam";
import { setOverviewWidgetAction } from "@/lib/prefsActions";
import { WorkspaceOverview } from "./WorkspaceOverview";

/** DW-3a: the one branch every Overview page takes. A function that wraps the page's own body
 *  (`legacy`) in the Overview of the workspace the URL belongs to (a department by its org node id, a functional one by its
 *  slug); `null` for a URL that names no workspace of this company, so the caller renders its own page whole.
 *
 *  The page decides this BEFORE it reads its own data, builds its body once, and passes it through `wrap`,
 *  so the page reads exactly what it read before. Today's body stays under the Overview's bands until the
 *  Overview's own blocks replace it (plan §2.6 rule 1: nothing is removed). DW-3z: each page builds a smaller body for this frame,
 *  leaving out the sections the inventory in plan §3.8 (`lib/overviewCoverage.ts`) says a block or a tab now holds.
 *  SCP-Kl (SCP-Q24): the Social skin's Home is the feed alone and never goes through this frame (it had a second `lead` argument for the feed; gone). */
export async function pilotFrame(
  me: Me,
  tenantId: string,
  target: { deptId: string } | { slug: string },
  searchParams: Promise<{ period?: string | string[]; view?: string | string[] }>,
): Promise<((legacy: ReactNode) => ReactNode) | null> {
  // Three independent reads (the cookie, the org tree, the modules), started together: serially they added up on the first byte.
  // DW-3g: one read of the company's modules, so a block whose module is off is not placed. It fails open.
  // DW-10e: the company's routes to other group companies, for the Requests block's gate and the per-route actions. The Overview AWAITS them here (it is
  // a page under loading.tsx, already off the shell's first-byte path), in the same parallel group, and the read is the layout's own memoised promise, so
  // it costs nothing extra. A company whose pack has the Requests row (the agency pack) does not read them at all.
  const [prefs, all, modules, routes] = await Promise.all([
    getPrefs(), myWorkspaces(me, tenantId), moduleGate(me.userId, tenantId),
    needsRoutesRead(me, tenantId) ? routesForShell(me.userId, tenantId) : Promise.resolve(undefined),
  ]);
  const ref = workspaceRefForPage(all, target);
  if (!ref) return null;
  const { period, view } = await searchParams;
  // DW-6c: the Today block shows the tools this person pinned for this workspace (Tools & connections).
  // DW-5f: `all` gives the `hasWorkspace` gate the company's department workspaces.
  const subject = { ...subjectOfRef(ref, prefs.pinnedTools, all), routes };
  const parsed = parseOverviewPeriod(period);
  // DW-3h: the Me | Team switch is a head's, of THIS workspace's unit. For anyone else `?view=team` is ignored (Me), so
  // nothing about a team is read for them. The switch is cosmetic: the server narrows every Team read.
  const canSwitchView = canSwitchToTeam(me, tenantId, subject);
  const mode = resolveOverviewView(view, canSwitchView);
  return (legacy) => (
    <WorkspaceOverview me={me} tenantId={tenantId} subject={subject} period={parsed} view={mode} canSwitchView={canSwitchView} legacy={legacy} moduleOn={modules.isEnabled}
      customise={{ prefs: prefs.overview ?? {}, setWidget: setOverviewWidgetAction }} />
  );
}
