import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { rethrowIfSessionEnded } from "@/lib/sessionEnded";
import { getActivePortalCompany, getPortalCompanies } from "@/lib/portal-company";
import { PortalCompanySwitch } from "@/components/portal/PortalCompanySwitch";
import { getPortalOverview } from "@/lib/portal-data";
import { PortalShell } from "@/components/portal/PortalShell";
import { portalBadges } from "@/lib/portalNav";
import { isContributor, isStaff } from "@/lib/rbac";
import { CONTRIBUTOR_HOME, contributorFenceReason } from "@/lib/contributorRouting";
import { websiteEditorClients } from "@/lib/portalWebsiteAccess";
import { PATHNAME_HEADER, SEARCH_HEADER } from "@/lib/pathnameHeader";
import { loginHrefForReturn } from "@/lib/returnTo";

// CP-7 — the client portal's own route group.
//
// ── WHY A ROUTE GROUP AND NOT A SECOND NEXT APP ───────────────────────────────────────────────────
// The owner's 2026-08-04 decision was that the client side is a SEPARATE INTERFACE, and it is: its own
// layout, chrome, navigation, vocabulary and empty states, sharing not one pixel of the staff shell.
// What it deliberately does NOT duplicate is the plumbing — the HMAC session, the single server-side
// egress (`platformFetch`), the design tokens, DEMO_MODE, the Playwright harness and the CI build gate.
// A standalone app would have meant a second copy of all six, a second image, a second compose service
// and a second vhost, all to be kept in step. Moving this folder to its own app later is a
// mechanical change; unpicking a divergent duplicate of the session layer would not be.
//
// ── ROUTE OWNERSHIP ──────────────────────────────────────────────────────────────────────────────
// `(app)/portal/*` was DELETED, not left in place. Two route groups cannot both serve `/portal` — Next
// would fail the build on the collision — so this group now owns every `/portal` path. The old
// `/portal/[runId]` moved to `/portal/approvals/[runId]`, which also removes a real hazard: a dynamic
// segment directly under `/portal` sat one static sibling away from swallowing `/portal/invoices`.
//
// ── ACCESS ───────────────────────────────────────────────────────────────────────────────────────
// Staff are NOT redirected away. A manager legitimately opens the portal to see what their client sees,
// and the BFF answers 403 for anyone who is not a contact, which the overview surfaces as a teach-state
// rather than a crash. Authorization stays server-side (Cerbos + the portal scope predicate); this
// layout only decides what chrome to draw.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  // SCP-2: a visitor whose cookie is present but no longer valid reaches this redirect (the proxy only turns away a MISSING cookie, and it keeps the query), so
  // it carries the page they asked for, query included: `/portal/social?post=<id>` must survive the sign-in. The proxy hands both over on a document request.
  const toLogin = async (): Promise<never> => {
    const h = await headers();
    redirect(loginHrefForReturn(h.get(PATHNAME_HEADER), h.get(SEARCH_HEADER)));
  };
  if (!userId) return toLogin();
  // DW-7h (BFF §52.4): a session IT ended is let through, so Next redirects it to /auth/ended; see (app)/layout.tsx.
  // M5-W1f: a freelance contributor is not a client and not staff: their own shell is `/contributor` (see `(app)/layout.tsx` for the fence's answer).
  const me = await getMe(userId).catch((e: unknown) => { rethrowIfSessionEnded(e); if (contributorFenceReason(e)) redirect(CONTRIBUTOR_HOME); return null; });
  if (!me) return toLogin();
  if (isContributor(me)) redirect(CONTRIBUTOR_HOME);
  const company = await getActivePortalCompany(me);
  const tenant = company?.id ?? null;
  const companies = getPortalCompanies(me);

  // The header needs the client's name and the pending count, and the overview call already returns
  // both. Fetched HERE rather than in each page so the badge is present on every tab — and it costs
  // nothing extra on the dashboard, where Next dedupes the identical fetch within one render pass.
  // `.catch(() => null)` rather than a fallback object literal: the chrome must render even when the
  // backend is down. A layout that throws takes every page under it with it, so the ONE place a client
  // could still read "something is wrong" would be gone too.
  const overview = tenant
    ? (await getPortalOverview(userId, tenant).catch(() => null))?.overview ?? null
    : null;

  const { projectsBadge, billingBadge, overviewBadge } = portalBadges(overview);
  // WSK-49d: the Website tab is offered only to a holder of `client_website_editor` for one of THIS company's clients.
  // Cosmetic: the Website pages and the BFF refuse everyone else themselves.
  const showWebsite = websiteEditorClients(me.roles, (overview?.clients ?? []).map((c) => c.id)).length > 0;

  const initials = (me.name ?? me.email ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part: string) => part.charAt(0).toUpperCase())
    .join("") || "?";

  return (
    <PortalShell
      companyName={company?.name ?? null}
      companySwitch={companies.length > 1 ? <PortalCompanySwitch companies={companies} activeId={tenant} /> : null}
      clientName={overview?.client?.name ?? null}
      userName={me.name ?? me.email ?? "You"}
      userInitials={initials}
      projectsBadge={projectsBadge}
      billingBadge={billingBadge}
      overviewBadge={overviewBadge}
      staff={isStaff(me)}
      showWebsite={showWebsite}
    >
      {children}
    </PortalShell>
  );
}
