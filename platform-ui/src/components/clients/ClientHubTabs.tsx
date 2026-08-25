"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// CC-3 — the client hub's tab strip.
//
// Tabs are ROUTES, not client-side state, so a tab is linkable, shareable and survives a reload — a
// manager can paste "the client's commercial tab" into a chat and it opens there. That is also why
// this component holds no data: each tab route fetches its own, so opening the hub does not pay for
// six tabs the reader may never look at.
//
// The badge counts come from the hub aggregate the LAYOUT already fetches (one call for the whole
// shell), never from per-tab probes. A badge that costs a request per tab per page load is how a tab
// strip becomes the most expensive component on a screen.

export interface ClientHubTab {
  /** Path segment under `/clients/[clientId]`; `""` is the Overview (index) route. */
  segment: string;
  label: string;
  /** Rendered as a count pill when > 0. Omitted or 0 renders nothing — never a "0" chip, which reads
   *  as a broken badge rather than as "nothing outstanding". */
  badge?: number;
}

export function ClientHubTabs({ clientId, tabs }: { clientId: string; tabs: ClientHubTab[] }) {
  const pathname = usePathname() ?? "";
  const base = `/clients/${clientId}`;
  return (
    <nav aria-label="Client sections" className="ch-tabs">
      {tabs.map((t) => {
        const href = t.segment ? `${base}/${t.segment}` : base;
        // Exact match for the index tab, prefix match for the rest. Without the special case
        // "Overview" would light up on every tab (every path starts with the base), and with only
        // exact matching a detail route under a tab would light up nothing — the same two-rule shape
        // `PortalTabs` uses.
        const active = t.segment ? pathname.startsWith(href) : pathname === base;
        return (
          <Link key={t.segment || "overview"} href={href} className="ch-tab" aria-current={active ? "page" : undefined}>
            {t.label}
            {t.badge ? <span className="ch-tab__count" aria-label={`${t.badge} outstanding`}>{t.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
