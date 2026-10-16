import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { rethrowIfSessionEnded } from "@/lib/sessionEnded";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { Shell } from "@/components/shell/Shell";
import { isClientOnly } from "@/lib/rbac";
import { myWorkspaces } from "@/lib/workspaces-data";
import { approvalsGateInput } from "@/lib/workspaceAccess";
import { listApprovals } from "@/lib/approvals";
import { layoutHomeRedirect } from "@/lib/overview";
import { PATHNAME_HEADER } from "@/lib/pathnameHeader";
import { buildShellModel } from "@/lib/shellModel";

// `drawer` is the parallel slot the intercepted task route renders into (see @drawer/). It sits
// OUTSIDE <Shell>'s scroll container so the slide-over is positioned against the viewport rather
// than the scrolled main column.
export default async function AppLayout({ children, drawer }: { children: React.ReactNode; drawer: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
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
  const prefs = await getPrefs();
  // DW-8m: the pending approvals are read here, in parallel, for the Approvals row's gate and count (DW-D23). `listApprovals`
  // never throws (a failed read is `unavailable`, which shows the row), `myWorkspaces` never throws, and `buildShellModel` is
  // pure: a failure here is a bug, and it reaches the error boundary rather than another sidebar (DW-D38).
  const [workspaces, pending] = await Promise.all([myWorkspaces(me, tenantId), listApprovals(userId, { status: "pending" })]);
  const workspaceModel = buildShellModel({ me, tenantId, workspaces, approvals: approvalsGateInput({ items: pending.envelope.items, unavailable: pending.unavailable }) });
  // DW-3a2: `/` for a person whose home is a workspace is answered HERE, with a real 307. The page's own
  // redirect would stream (it sits under loading.tsx) and leave a meta refresh that breaks client navigation.
  const homeHref = layoutHomeRedirect({ pathname: (await headers()).get(PATHNAME_HEADER), home: workspaces.home, tenantId });
  if (homeHref) redirect(homeHref);
  return (
    <>
      <Shell me={me} tenantId={tenantId} prefs={prefs} workspaceModel={workspaceModel}>
        {children}
      </Shell>
      {drawer}
    </>
  );
}
