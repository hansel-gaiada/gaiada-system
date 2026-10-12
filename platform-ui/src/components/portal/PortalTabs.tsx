"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PORTAL_AREAS, PORTAL_WEBSITE_HREF, activePortalNav } from "@/lib/portalNav";

// The portal's navigation: five areas, each with sub-tabs (ruling PV-D4,
// docs/plans/2026-10-10-three-perspectives.md; PV2-04). A client component only because the active
// area needs `usePathname`.
//
// WHY FIVE AREAS: eleven flat tabs made a client scan a long strip to find one thing. The areas follow
// the questions a client asks: where are we (Overview), what is being built (Projects, with the
// approvals, deliverables, requests, post reviews and timeline that hang off it), who are we
// (Business), what did we agree and what do I owe (Contracts & billing), who is on the account (People).
//
// WHY NO PATH MOVED: the sub-tab paths (/portal/approvals, /deliverables, /requests, /social-reviews,
// /timeline, /contracts, /invoices) are already in emails and notifications sent to clients
// (finding 7). Regrouping happens here, in the nav only; nothing is renamed or redirected. Each area's
// primary link goes to its FIRST sub-tab.
//
// BADGES: Projects carries the count of gates waiting on the client plus the threads with unread messages from our
// team (`conversationUnread`, PV4-08; see `portalBadges`); Contracts & billing carries unsigned
// contracts plus overdue invoices (both computed in the layout from the overview it already fetches).
// The "Post reviews" sub-tab deliberately carries NO badge: SMM-31/32's backend never extended
// `portal/overview`'s `needsYou`, so a badge would cost every portal page load a second always-on fetch
// just to produce one, or claim an unverified number. The list page surfaces its own pending count once
// opened.
//
// WEBSITE (WSK-49d): the Business area's second tab exists for everyone in `PORTAL_AREAS` (so every page maps to an
// area), but is OFFERED only when `showWebsite` is true: the viewer holds a website-editor grant for the active client.
// Cosmetic, never a gate; the Website pages and the BFF refuse everyone else on their own.
export function PortalTabs({ projectsBadge, billingBadge, showWebsite = false }: { projectsBadge: number; billingBadge: number; showWebsite?: boolean }) {
  const pathname = usePathname() ?? "/portal";
  const { areaKey, tabHref } = activePortalNav(pathname);
  const badges: Record<string, number> = { projects: projectsBadge, billing: billingBadge };
  const found = PORTAL_AREAS.find((a) => a.key === areaKey) ?? null;
  const active = found && { ...found, tabs: found.tabs.filter((t) => showWebsite || t.href !== PORTAL_WEBSITE_HREF) };
  return (
    <>
      <nav className="cp-tabs" aria-label="Portal sections">
        {PORTAL_AREAS.map((a) => {
          const count = badges[a.key] ?? 0;
          return (
            <Link
              key={a.key}
              href={a.tabs[0].href}
              className="cp-tab"
              aria-current={a.key === areaKey ? "page" : undefined}
            >
              {a.label}
              {count > 0 && (
                <span className="cp-tab__count" aria-label={`${count} waiting for you`}>{count}</span>
              )}
            </Link>
          );
        })}
      </nav>
      {active && active.tabs.length > 1 && (
        <nav className="cp-subtabs" aria-label={`${active.label} pages`}>
          {active.tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="cp-subtab"
              aria-current={t.href === tabHref ? "page" : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
