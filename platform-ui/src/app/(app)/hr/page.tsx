import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { hrScopeCompanies, listLeave, listCases } from "@/lib/hr";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { pilotFrame } from "@/components/overview/pilot";
import { keepsSection } from "@/lib/overviewCoverage";

// The four area cards: each is a link and one line of words, and each area is a row or tab of the HR workspace (plan §3.8).
const AREA_CARDS = [
  { section: "card-leave", title: "Leave", href: "/hr/leave", text: "File leave, track balances, and clear the approval queue." },
  { section: "card-attendance", title: "Attendance", href: "/hr/attendance", text: "Daily present/remote/absent/leave log." },
  { section: "card-onboarding", title: "Onboarding", href: "/hr/onboarding", text: "Onboarding/offboarding checklist board." },
  { section: "card-cases", title: "Cases", href: "/hr/cases", text: "Review-lite, grievance and general HR cases." },
] as const;

// HR console home — headcount and org shape at a glance, plus a way into the
// people directory and the leave/attendance/onboarding/cases surfaces (WSD-5).
// The scope pill here is informational (which companies you serve for HR) —
// each sub-page owns its own `?company=` scope and envelope.
export default async function HROverviewPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  // DW-3a: on the pilot switch the Overview frames this page body, which stays below its bands until the
  // Overview's own blocks replace it. The body is built once, below, and passed through `frame`.
  // DW-3z: under the frame, the cards that are only links to the workspace's own rows and tabs go (plan §3.8); the counts and the
  // scope note stay, because no block shows them yet.
  const frame = await pilotFrame(me, tenant, { slug: "hr" }, searchParams);
  const keeps = (section: string) => keepsSection("hr", section, { framed: !!frame });
  const areaCards = AREA_CARDS.filter((c) => keeps(c.section));

  const scopeCompanies = hrScopeCompanies(me, tenant);
  const [members, depts, pendingLeave, openCases] = await Promise.all([
    listMembers(userId, tenant).catch(() => []),
    listDepartmentBriefs(userId, tenant).catch(() => []),
    listLeave(userId, tenant, { status: "pending" }),
    listCases(userId, tenant, { status: "open" }),
  ]);

  const body = (
    <>
      {scopeCompanies.length > 1 && (
        <p style={{ margin: "0 0 16px", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)", textAlign: "right" }}>
          You serve HR for {scopeCompanies.length} companies — {scopeCompanies.map((c) => c.name).join(", ")}. Pick one on
          {" "}<Link href="/hr/leave" style={{ color: "var(--erp-accent)" }}>Leave</Link>,{" "}
          <Link href="/hr/attendance" style={{ color: "var(--erp-accent)" }}>Attendance</Link>,{" "}
          <Link href="/hr/onboarding" style={{ color: "var(--erp-accent)" }}>Onboarding</Link> or{" "}
          <Link href="/hr/cases" style={{ color: "var(--erp-accent)" }}>Cases</Link>.
        </p>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 22 }}>
        <KpiTile label="People" value={String(members.length)} foot="in this company" />
        <KpiTile label="Departments" value={String(depts.length)} />
        <KpiTile label="Leave pending" value={String(pendingLeave.length)} />
        <KpiTile label="Open cases" value={String(openCases.length)} />
      </div>

      {areaCards.length > 0 && (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 22 }}>
          {areaCards.map((c) => (
            <Card key={c.section} title={c.title} headerRight={<Link href={c.href} className="lux-btn lux-btn--ghost lux-btn--sm">Open →</Link>}>
              <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>{c.text}</p>
            </Card>
          ))}
        </div>
      )}

      {keeps("people-directory") && <Card
        title="People directory"
        headerRight={<Link href="/hr/people" className="lux-btn lux-btn--ghost lux-btn--sm">Open directory →</Link>}
      >
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--erp-ink-60)", maxWidth: 620 }}>
          Everyone in {me.companies.find((c) => c.id === tenant)?.name ?? "this company"} — profiles, roles, assigned work and
          identity links. Manage placement in the org structure from the Org tab.
        </p>
      </Card>}
    </>
  );
  return frame ? frame(body) : body;
}
