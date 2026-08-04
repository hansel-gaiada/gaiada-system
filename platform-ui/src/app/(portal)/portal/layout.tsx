import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalOverview } from "@/lib/portal-data";
import { PortalShell } from "@/components/portal/PortalShell";

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
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");
  const tenant = await getActiveTenant(me);

  // The header needs the client's name and the pending count, and the overview call already returns
  // both. Fetched HERE rather than in each page so the badge is present on every tab — and it costs
  // nothing extra on the dashboard, where Next dedupes the identical fetch within one render pass.
  // `.catch(() => null)` rather than a fallback object literal: the chrome must render even when the
  // backend is down. A layout that throws takes every page under it with it, so the ONE place a client
  // could still read "something is wrong" would be gone too.
  const overview = tenant
    ? (await getPortalOverview(userId, tenant).catch(() => null))?.overview ?? null
    : null;

  const initials = (me.name ?? me.email ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part: string) => part.charAt(0).toUpperCase())
    .join("") || "?";

  return (
    <PortalShell
      clientName={overview?.client?.name ?? null}
      userName={me.name ?? me.email ?? "You"}
      userInitials={initials}
      pendingCount={overview?.needsYou?.length ?? 0}
    >
      {children}
    </PortalShell>
  );
}
