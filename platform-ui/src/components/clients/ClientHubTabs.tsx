"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hubTabHref, isHubTabActive } from "@/lib/clientHubNav";

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
  /** PV3-05: a STAFF-ONLY area the client never sees (Internal). Styled apart from every other tab and
   *  labelled in words — see `.ch-tab--internal`. */
  internal?: boolean;
}

export function ClientHubTabs({ clientId, tabs }: { clientId: string; tabs: ClientHubTab[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Client sections" className="ch-tabs">
      {tabs.map((t) => {
        const href = hubTabHref(clientId, t.segment);
        // Exact match for the index tab, SEGMENT-BOUNDARY match for the rest (`isHubTabActive`). A bare
        // `startsWith` lit `/work` for `/workshop`; with only exact matching a detail route under a tab
        // would light nothing — the same two-rule shape `PortalTabs` uses.
        const active = isHubTabActive(pathname, clientId, t.segment);
        return (
          <Link
            key={t.segment || "overview"}
            href={href}
            className={t.internal ? "ch-tab ch-tab--internal" : "ch-tab"}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
            {t.internal ? <span className="ch-tab__staff">Staff only</span> : null}
            {t.badge ? <span className="ch-tab__count" aria-label={`${t.badge} outstanding`}>{t.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
