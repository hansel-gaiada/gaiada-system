"use client";
import { usePathname } from "next/navigation";
import { type DeptGroup, tabHref } from "@/lib/deptToolkits";

// Console-body shell (P1-01, docs/superpowers/plans/
// 2026-07-23-pm-console-ux-design-spec.md §1). Owns the choice between the
// persistent-rail 2-col grid (Home) and the full-bleed single column
// (Board/Timeline/Projects/Project-workspace) — structurally wide surfaces
// that stay full width independent of the user's global width pref. Runs the
// SAME deepest-prefix active-tab resolution as `DeptTabs` against the current
// pathname so the two components can never disagree about which tab is
// active, plus a manual match for the nested in-console project workspace
// route (`/departments/{deptId}/projects/{projectId}`, added by a later
// ticket) which isn't a toolkit tab itself but must inherit Projects'
// full-bleed treatment. When full-bleed, the rail is not rendered into the
// DOM at all (not just hidden) — it does no work and isn't present for a11y
// tools to trip over.
export function DeptShellFrame({
  groups,
  deptId,
  rail,
  children,
}: {
  groups: DeptGroup[];
  deptId: string;
  rail: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  let active: { href: string; len: number; fullBleed?: boolean } | null = null;
  for (const g of groups) {
    for (const t of g.tabs) {
      const href = tabHref(deptId, t);
      const match = pathname === href || pathname.startsWith(`${href}/`);
      if (match && (!active || href.length > active.len)) {
        active = { href, len: href.length, fullBleed: t.fullBleed };
      }
    }
  }

  const projectWorkspaceMatch = new RegExp(`^/departments/${deptId}/projects/[^/]+`).test(pathname ?? "");
  const isFullBleed = Boolean(active?.fullBleed) || projectWorkspaceMatch;

  if (isFullBleed) {
    return <div className="dept-shell dept-shell--full">{children}</div>;
  }

  return (
    <div className="dept-shell">
      <div className="dept-shell__main">{children}</div>
      <div className="dept-shell__rail">{rail}</div>
    </div>
  );
}
