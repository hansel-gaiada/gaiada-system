import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { monthTitle, parseMonth, shiftMonth } from "@/lib/deptCalendar";
import { getCycleTable, getSocialSettings } from "@/lib/socialCycles-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SocialSettingsForm } from "@/components/social/SocialSettingsForm";
import { CycleDeadlineTable } from "@/components/social/CycleDeadlineTable";
import "@/components/social/cycles.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ month?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

const settingsHref = (deptId: string, month: string, today: string): string => {
  const base = `/departments/${encodeURIComponent(deptId)}/settings`;
  return month === today.slice(0, 7) ? base : `${base}?month=${month}`;
};

// SCP-1c (BFF §63.4, §63.5; plan §4.4): the Social Media Settings page, the four approvers' (the registry row gates on `canLeadSocial`, PERMISSION §53.4).
//
// The page is READABLE by the whole team (`GET settings`, `GET cycles`: `social_post` · `read`) and EDITABLE only with `canPlan` (the server's answer to
// `social_engagement` · `plan`), so a person who opens it by address without the right sees the values and disabled controls with the reason. The gate
// hides the row, never the data, and grants nothing.
//
// Three parts: the schedule settings (buffer, boost-candidate factor, whether a holiday calendar is known), the step estimates (a slot: they are edited
// through the allocation route SCP-1a builds next), and the month's deadline table (pre-fill, deadline, ready-by, counts, health). A refused read is the
// house "no access" state and a failed one says it cannot tell, never an empty table.
export default async function SocialSettingsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // Company-wide social settings belong to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const today = todayIsoInDisplayZone();
  const month = parseMonth(first(sp.month), today.slice(0, 7));
  const [settings, table] = await Promise.all([getSocialSettings(userId, tenant), getCycleTable(userId, tenant, month)]);

  if (settings.kind === "forbidden" || table.kind === "forbidden") {
    return <ReadRefusal subject="the Social Media settings" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (settings.kind === "unavailable") return <ReadRefusal subject="The Social Media settings" kind="unavailable" reason={settings.reason} />;
  if (table.kind === "unavailable") return <ReadRefusal subject="The deadline table" kind="unavailable" reason={table.reason} />;

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return (
    <Card title="Settings">
      <div className="scp-sections">
        <SocialSettingsForm settings={settings.data} />

        {/* SCP-1a SLOT: the per-client step estimates (working days for proofread, HoD approval, design, final check, client approval and scheduling).
            They are edited through the allocation route SCP-1a builds next (`PATCH engagements/:engagementId/allocation`, `stepEstimates`); this page
            only reserves the place. Do not build the route here. */}
        <section aria-labelledby="scp-estimates-title" className="scp-slot" data-slot="step-estimates">
          <h3 className="scp-slot__title" id="scp-estimates-title">Step estimates</h3>
          <p className="scp-note" style={{ marginTop: 0 }}>
            How many working days each step takes for each client: proofread, HoD approval, design, final check, client approval and scheduling. With them a post
            shows the latest safe day to hand it on; without them, only the ready-by date. They are set per client with its allocation, which arrives next.
          </p>
        </section>

        <section aria-labelledby="scp-deadlines-title">
          <h3 className="scp-section__title" id="scp-deadlines-title">Deadlines</h3>
          <p className="scp-lede">
            Each client&rsquo;s content month has one deadline. The pre-fill follows the client&rsquo;s batch: A is the last working day on or before the 15th of the month
            before, B the last working day of the month before.
          </p>
          <nav className="scp-monthnav" aria-label="Month">
            <Link href={settingsHref(deptId, prev, today)} className="scp-monthnav__btn" aria-label={`Previous month, ${monthTitle(prev)}`}>←</Link>
            <h4 className="scp-monthnav__title">{monthTitle(month)}</h4>
            <Link href={settingsHref(deptId, next, today)} className="scp-monthnav__btn" aria-label={`Next month, ${monthTitle(next)}`}>→</Link>
            {month !== today.slice(0, 7) && <Link href={settingsHref(deptId, today.slice(0, 7), today)} className="scp-monthnav__btn">This month</Link>}
          </nav>
          {/* keyed by month so stepping months resets the editable drafts */}
          <CycleDeadlineTable key={month} table={table.data} />
        </section>
      </div>
    </Card>
  );
}
