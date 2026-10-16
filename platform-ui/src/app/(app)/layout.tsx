import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { rethrowIfSessionEnded } from "@/lib/sessionEnded";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { Shell } from "@/components/shell/Shell";
import { ShellApprovalsFeed } from "@/components/shell/ShellApprovalsFeed";
import { isClientOnly } from "@/lib/rbac";
import { myWorkspaces } from "@/lib/workspaces-data";
import { listApprovals } from "@/lib/approvals";
import { layoutHomeRedirect } from "@/lib/overview";
import { PATHNAME_HEADER } from "@/lib/pathnameHeader";
import { buildShellModel } from "@/lib/shellModel";
import { routesForShell } from "@/lib/requests-data";
import { needsRoutesRead } from "@/lib/workspaceAccess";
import { ShellRoutesFeed } from "@/components/shell/ShellRoutesFeed";

// `drawer` is the parallel slot the intercepted task route renders into (see @drawer/). It sits
// OUTSIDE <Shell>'s scroll container so the slide-over is positioned against the viewport rather
// than the scrolled main column.
export default async function AppLayout({ children, drawer }: { children: React.ReactNode; drawer: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  // DW-9d perf: the pending approvals need only the user id, so the read starts NOW and overlaps `/api/me` and the org read. It is not awaited
  // here at all: the shell's first byte does not wait for it (the Approvals row's count streams in through `ShellApprovalsFeed`, below).
  // `listApprovals` never throws (a failed read is `unavailable`, which shows the row), so an abandoned promise (a redirect below) is harmless.
  const pendingApprovals = listApprovals(userId, { status: "pending" });
  // DW-7h (BFF §52.4): a session IT ended is let through, so Next redirects it to /auth/ended (which clears the
  // cookie and says why); any other failure still lands on /login.
  const me = await getMe(userId).catch((e: unknown) => { rethrowIfSessionEnded(e); return null; });
  if (!me) redirect("/login");

  // An external client has no business anywhere in the STAFF group. This lives in the layout, not on
  // the root page, because the layout is the only place that covers the whole group: redirecting from
  // `(app)/page.tsx` alone still let a client reach /projects, /tasks or /meetings and get the staff
  // shell, where every read 403-degrades into an empty page that reads like "you have no projects".
  //
  // The inverse is deliberately NOT symmetric: `(portal)/portal/layout.tsx` does NOT bounce staff,
  // because a manager legitimately opens the portal to see what their client sees. Only the
  // client -> staff direction is a mistake.
  if (isClientOnly(me)) redirect("/portal");

  const tenantId = await getActiveTenant(me);
  // `myWorkspaces` never throws and `buildShellModel` is pure: a failure here is a bug, and it reaches the error boundary rather than
  // another sidebar (DW-D38).
  const [prefs, workspaces] = await Promise.all([getPrefs(), myWorkspaces(me, tenantId)]);
  // DW-10e (BFF §60.9) + DW-9 perf: the company's routes (`GET requests/routes`) are NOT on the first-byte path. A company whose pack already has the
  // Requests row (the agency pack) never reads them at all. Any other company starts the read here WITHOUT awaiting it (memoised per request, so the
  // Overview shares it): the model is built with `routes: "inflight"`, which hides every routes-gated row and "Ask ..." action, and a <Suspense> child
  // (`ShellRoutesFeed`) settles them: shown when routes exist, hidden when there are none or the read failed. `routesForShell` never throws.
  const routesRead = needsRoutesRead(me, tenantId) ? routesForShell(me.userId, tenantId) : null;
  // DW-8m / DW-D23: the Approvals row's gate and count. The model is built with the read IN FLIGHT: the row is shown to a person who
  // holds a decide right (computed here, with no read) and hidden from one who does not, until `ShellApprovalsFeed` settles it: shown
  // when something waits on them or they may decide, with the pending count as its badge; an unavailable read shows it.
  const workspaceModel = buildShellModel({ me, tenantId, workspaces, approvals: "inflight", ...(routesRead ? { routes: "inflight" as const } : {}) });
  // DW-3a2: `/` for a person whose home is a workspace is answered HERE, with a real 307. The page's own
  // redirect would stream (it sits under loading.tsx) and leave a meta refresh that breaks client navigation.
  const homeHref = layoutHomeRedirect({ pathname: (await headers()).get(PATHNAME_HEADER), home: workspaces.home, tenantId });
  if (homeHref) redirect(homeHref);
  return (
    <>
      <Shell me={me} tenantId={tenantId} prefs={prefs} workspaceModel={workspaceModel}
        approvalsFeed={<Suspense fallback={null}><ShellApprovalsFeed read={pendingApprovals} /></Suspense>}
        routesFeed={routesRead ? <Suspense fallback={null}><ShellRoutesFeed read={routesRead} /></Suspense> : undefined}>
        {children}
      </Shell>
      {drawer}
    </>
  );
}
