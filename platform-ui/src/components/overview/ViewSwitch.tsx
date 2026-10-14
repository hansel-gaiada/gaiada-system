import Link from "next/link";
import type { OverviewPeriod } from "@/lib/overview";
import { OVERVIEW_VIEW_OPTIONS, viewHref, type OverviewView } from "@/lib/overviewTeam";

// DW-3h: the Me | Team switch of a head of department (plan §3.4, DW-D8). The choice lives in the URL (`?view=team`), like the
// period, so a reload, a shared link and the server-rendered blocks all agree. Two plain links, not buttons, so it works
// without JavaScript, and each keeps `?period=`. The frame draws it only for a head of this workspace's unit
// (`canSwitchToTeam`); it is cosmetic, and the server narrows every Team read.
export function ViewSwitch({ value, period }: { value: OverviewView; period: OverviewPeriod }) {
  return (
    <nav className="ov-view" aria-label="View">
      {OVERVIEW_VIEW_OPTIONS.map((o) => (
        <Link
          key={o.key}
          href={viewHref(period, o.key)}
          className="ov-view__link"
          aria-current={value === o.key ? "true" : undefined}
          scroll={false}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
