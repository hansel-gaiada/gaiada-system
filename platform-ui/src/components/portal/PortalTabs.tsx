"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// The portal's nine destinations. A client component only because the active tab needs `usePathname`.
//
// Order is the order a client asks the questions in: where are we, on what, when, what did we get, what
// do I need to ask for, what do you need from me, what do I owe, what did we agree, who am I. "Requests"
// (MI-04) sits between Deliverables and Approvals — asking for something is a different act from
// signing something, so it does not get folded into the Approvals tab even though both can end up
// waiting on staff. "Invoices" and "Agreements" are not buried under a Settings-like grouping — being
// able to find your own contract is a headline feature of a client portal, not an administrative detail.
const TABS: Array<{ href: string; label: string; badge?: "pending" }> = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/projects", label: "Projects" },
  { href: "/portal/timeline", label: "Timeline" },
  { href: "/portal/deliverables", label: "Deliverables" },
  { href: "/portal/requests", label: "Requests" },
  { href: "/portal/approvals", label: "Approvals", badge: "pending" },
  // SMM-31/32 — social-post sign-off. Its own tab rather than folded into "Approvals": that tab's
  // pending count comes from `portal/overview`'s `needsYou` (gates + unsigned contracts), which
  // SMM-31's backend never extended — this tab deliberately carries NO badge rather than costing
  // every portal page load a second always-on fetch just to produce one, or claiming an unverified
  // number. The list page itself surfaces its own pending count once opened.
  { href: "/portal/social-reviews", label: "Post reviews" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/contracts", label: "Agreements" },
  { href: "/portal/profile", label: "Profile" },
];

export function PortalTabs({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "/portal";
  return (
    <>
      {TABS.map((t) => {
        // Exact match for the root tab, prefix match for the rest — otherwise "/portal" would light up
        // on every page (every path starts with it) and a detail route like
        // `/portal/invoices/inv-1` would light up nothing.
        const active = t.href === "/portal" ? pathname === "/portal" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className="cp-tab" aria-current={active ? "page" : undefined}>
            {t.label}
            {t.badge === "pending" && pendingCount > 0 && (
              <span className="cp-tab__count" aria-label={`${pendingCount} waiting for you`}>{pendingCount}</span>
            )}
          </Link>
        );
      })}
    </>
  );
}
