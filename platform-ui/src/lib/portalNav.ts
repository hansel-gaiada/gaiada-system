// PV2-04 — the client portal's navigation map (ruling PV-D4, docs/plans/2026-10-10-three-perspectives.md).
//
// Pure and client-safe: no imports from the server layer, so PortalTabs (a client component) and the
// layout (a server component) can both use it. Portal-only on purpose — it shares nothing with the
// staff shell's DeptTabs.
//
// Matching is longest-prefix on a path-segment boundary, with an exact match only for `/portal` (every
// portal path starts with it). Unknown paths map to nulls, never throw.
import type { PortalOverview } from "./portal";

export interface PortalSubTab { href: string; label: string }

/** The Website tab's path, so the nav, the tab filter and the guards name it once. */
export const PORTAL_WEBSITE_HREF = "/portal/website";
export interface PortalArea { key: string; label: string; tabs: PortalSubTab[] }

export const PORTAL_AREAS: PortalArea[] = [
  { key: "overview", label: "Overview", tabs: [{ href: "/portal", label: "Overview" }] },
  {
    key: "projects",
    label: "Projects",
    tabs: [
      { href: "/portal/projects", label: "Projects" },
      { href: "/portal/approvals", label: "Approvals" },
      { href: "/portal/deliverables", label: "Deliverables" },
      { href: "/portal/requests", label: "Requests" },
      // PV4-08: threads with our team, one per project plus a General one. `/portal/meetings/:id` (shared meeting
      // notes) has no tab of its own: see PORTAL_PATH_ALIASES.
      { href: "/portal/conversation", label: "Conversation" },
      { href: "/portal/social-reviews", label: "Post reviews" },
      { href: "/portal/timeline", label: "Timeline" },
    ],
  },
  {
    key: "business",
    label: "Business",
    tabs: [
      { href: "/portal/company", label: "Business" },
      // WSK-49d: shown only to a viewer holding a `client_website_editor` grant for the active client
      // (`PortalTabs` filters it; `lib/portalWebsiteAccess.ts`). The pages guard themselves as well.
      { href: PORTAL_WEBSITE_HREF, label: "Website" },
    ],
  },
  {
    key: "billing",
    label: "Contracts & billing",
    tabs: [
      { href: "/portal/contracts", label: "Contracts" },
      { href: "/portal/invoices", label: "Invoices" },
      // PV5-08: signed agreements, issued-invoice PDFs and payment receipts in one list. A new path; every other is kept.
      { href: "/portal/documents", label: "Documents" },
    ],
  },
  { key: "people", label: "People", tabs: [{ href: "/portal/profile", label: "People" }] },
];

/** Paths that belong to an area without being a tab of it. Meeting notes are reached from a project's page and from
 *  the "minutes shared" notice (`/portal/meetings/<id>`); they sit in Projects and light that area's first tab. */
const PORTAL_PATH_ALIASES: Array<{ prefix: string; areaKey: string; tabHref: string }> = [
  { prefix: "/portal/meetings", areaKey: "projects", tabHref: "/portal/projects" },
];

export function activePortalNav(pathname: string): { areaKey: string | null; tabHref: string | null } {
  const path = (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (path === "/portal") return { areaKey: "overview", tabHref: "/portal" };
  let best: { areaKey: string; tabHref: string } | null = null;
  for (const area of PORTAL_AREAS) {
    for (const tab of area.tabs) {
      if (tab.href === "/portal") continue;
      if (path === tab.href || path.startsWith(tab.href + "/")) {
        if (!best || tab.href.length > best.tabHref.length) best = { areaKey: area.key, tabHref: tab.href };
      }
    }
  }
  if (!best) {
    const alias = PORTAL_PATH_ALIASES.find((a) => path === a.prefix || path.startsWith(a.prefix + "/"));
    if (alias) return { areaKey: alias.areaKey, tabHref: alias.tabHref };
  }
  return best ?? { areaKey: null, tabHref: null };
}

/** Badge counts for the two areas that can have something waiting on the client. Projects = gates waiting on the
 *  client + threads with unread messages from our team (`conversationUnread`, PV4-06). */
export function portalBadges(
  overview: Pick<PortalOverview, "needsYou" | "finance" | "conversationUnread"> | null | undefined,
): { projectsBadge: number; billingBadge: number } {
  const needs = overview?.needsYou ?? [];
  const overdue = (overview?.finance?.byCurrency ?? []).reduce((sum, c) => sum + (c.overdueCount ?? 0), 0);
  return {
    projectsBadge: needs.filter((n) => n.kind === "gate").length + Math.max(0, overview?.conversationUnread ?? 0),
    billingBadge: needs.filter((n) => n.kind === "contract").length + overdue,
  };
}
