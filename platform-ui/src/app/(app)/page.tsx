import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { Eyebrow } from "@/components/ui";
import { WorkspaceOverview } from "@/components/overview/WorkspaceOverview";
import { myWorkspaces } from "@/lib/workspaces-data";
import { COMPANY_SUBJECT, parseOverviewPeriod, resolveHomeRoute } from "@/lib/overview";
import { getPrefs } from "@/lib/prefs";
import { setOverviewWidgetAction } from "@/lib/prefsActions";

type SearchParams = Promise<{ period?: string }>;

// `/` is not a page of its own: it is where a person's home goes (DW-3a, DW-D38). A person whose home is a workspace is sent
// to that workspace's Overview; one whose home is the Company area stays for the company-level frame; a person with no active
// company has nothing to open and is told so. The classic My Work / Command Center body is gone with the classic layout.
export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  // An external client never reaches this page: `(app)/layout.tsx` sends them to /portal, the one guard at the group boundary.

  const tenantId = await getActiveTenant(me);
  const { period: rawPeriod } = await searchParams;

  if (!tenantId) {
    return (
      <>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Your workspace</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 32, letterSpacing: "-0.015em", lineHeight: 1.04 }}>
          No company yet
        </h1>
        <p style={{ margin: "14px 0 18px", maxWidth: "56ch" }}>You are not a member of any company yet. Ask an administrator to add you.</p>
        <Link href="/account" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>Open your account</Link>
      </>
    );
  }

  // Two redirects cover `/`: the layout's (a real 307 on a document request) and this one (a client-side
  // navigation to `/` does not re-render the layout, and there the redirect rides the RSC payload, no meta tag).
  const route = resolveHomeRoute({ home: (await myWorkspaces(me, tenantId)).home, tenantId });
  if (route.kind === "redirect") redirect(route.href);
  // DW-10d (DW-D34): the company-level Overview can be personalised like any other.
  const prefs = await getPrefs();
  return <WorkspaceOverview me={me} tenantId={tenantId} subject={COMPANY_SUBJECT} period={parseOverviewPeriod(rawPeriod)} customise={{ prefs: prefs.overview, setWidget: setOverviewWidgetAction }} />;
}
