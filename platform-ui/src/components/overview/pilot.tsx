import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import { getPrefs } from "@/lib/prefs";
import { myWorkspaces } from "@/lib/workspaces-data";
import { parseOverviewPeriod, subjectOfRef, workspaceRefForPage } from "@/lib/overview";
import { WorkspaceOverview } from "./WorkspaceOverview";

/** DW-3a: the one branch every Overview page takes. For a person on the pilot switch, a function that wraps
 *  the page's own body (`legacy`) in the Overview of the workspace the URL belongs to (a department by its
 *  org node id, a functional one by its slug); `null` for everyone else, and for a URL that names no
 *  workspace of this company, so the caller renders its own page exactly as it always did.
 *
 *  The page decides this BEFORE it reads its own data, builds its body once, and passes it through `wrap`,
 *  so the page reads exactly what it read before. Today's body stays under the Overview's bands until the
 *  Overview's own blocks replace it (plan §2.6 rule 1: nothing is removed). */
export async function pilotFrame(
  me: Me,
  tenantId: string,
  target: { deptId: string } | { slug: string },
  searchParams: Promise<{ period?: string | string[] }>,
): Promise<((legacy: ReactNode) => ReactNode) | null> {
  const prefs = await getPrefs();
  if (prefs.shell !== "workspaces") return null;
  const all = await myWorkspaces(me, tenantId);
  const ref = workspaceRefForPage(all, target);
  if (!ref) return null;
  const { period } = await searchParams;
  const subject = subjectOfRef(ref, all);
  const parsed = parseOverviewPeriod(period);
  return (legacy) => <WorkspaceOverview me={me} tenantId={tenantId} subject={subject} period={parsed} legacy={legacy} />;
}
