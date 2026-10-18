import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, canInUnit, leadUnits, leadsAnyUnitWith, unitPathOf } from "@/lib/rbac";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getReportOverview } from "@/lib/reports-data";
import { readResult } from "@/lib/readResult";
import { getActivitySeries } from "@/lib/activitySeries";
import { TEAM_PERIODS, buildTeamActivity, parseTeamPeriod, teamRequestFrom, unitOptions, type TeamPeriod } from "@/lib/activityTeam";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { fmtDay } from "@/components/pm/activityHeatmap";
import { TeamActivityTable } from "@/components/analytics/TeamActivityTable";
import "@/components/analytics/activity.css";

// Analytics > Team activity (DW-4i, docs/FRONTEND-BFF-CONTRACT.md section 44.9): for the head of a unit, what each person on
// the roster did BY KIND over a period (this week, month or quarter; month by default).
//
// WHO SEES IT: the Team report's own rule (`reports.department.view`, held company-wide or as a head of the unit, `canInUnit`).
// A person who is not a head is told so, and nothing about a team is read for them. This is cosmetic: the roster read
// (BFF section 37) and every person's series (BFF section 44.3) are gated by the server, per call.
//
// THE ROSTER is `GET /reports/overview?grain=person&unit=` as of today: the unit's WHOLE roster, so a quiet person is listed.
// Each person's series is read in parallel; a refused or failed person is "Unavailable" on their row alone.
//
// DW-D19: no ranking, no total, no sort by volume. Rows are by name; each row opens that person's own My activity view.
const TITLE = "Team activity";
const CAP = "reports.department.view" as const;
const DENIED = "Team activity is for the head of a department, HR and company-wide readers. Your own work is under Analytics › My activity.";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const todayIso = () => new Date().toISOString().slice(0, 10);

function periodHref(unit: string, p: TeamPeriod): string {
  return `/analytics/activity/team?${new URLSearchParams({ unit, period: p }).toString()}`;
}

export default async function TeamActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string | string[]; period?: string | string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  // Staff who lead no one never see the Team mode, and nothing about a team is read for them.
  const wide = can(me, CAP, tenant);
  if (!wide && !leadsAnyUnitWith(me, CAP, tenant)) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>{DENIED}</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const unit = first(sp.unit) || null;
  const period = parseTeamPeriod(sp.period);
  const root = await readOrgRoot(me, tenant);

  // No unit: pick one. A head is offered the units they lead (and what sits beneath them); a company-wide reader, every department.
  if (unit === null) {
    const options = root ? unitOptions(root, wide ? null : leadUnits(me, tenant)) : [];
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <div className="act">
          {root === null ? (
            <EmptyNote>Unavailable: the organisation could not be read.</EmptyNote>
          ) : options.length === 0 ? (
            <EmptyNote>There is no department you lead in this company.</EmptyNote>
          ) : (
            <Card title="Choose a department">
              <ul className="act-units">
                {options.map((o) => (
                  <li key={o.value}><Link href={periodHref(o.value, period)}>{o.label}</Link></li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </>
    );
  }

  // A unit: the caller must be able to read it (company-wide, or a head of it or of a unit above it). The org tree decides
  // "above it"; without the tree only a company-wide reader goes on, and the server still has the last word.
  const mayRead = wide || (root !== null && canInUnit(me, CAP, tenant, unitPathOf(root, unit)));
  if (!mayRead) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>{DENIED}</EmptyNote>
      </>
    );
  }

  const today = todayIso();
  const roster = await readResult(getReportOverview(tenant, userId, { grain: "person", unit, periodKind: "month", start: today, end: today }));
  const unitName = root ? (unitOptions(root, null).find((o) => o.value === unit)?.label ?? null) : null;
  const heading = unitName ? `${TITLE}: ${unitName}` : TITLE;
  const change = <Link href="/analytics/activity/team" className="lux-btn lux-btn--ghost lux-btn--sm">Change department</Link>;

  if (roster.kind !== "ok") {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={heading} actions={change} />
        <EmptyNote>
          {roster.kind === "forbidden" ? `No access: ${DENIED}` : `Unavailable: the roster could not be read (${roster.reason}).`}
        </EmptyNote>
      </>
    );
  }

  const people = roster.data.scopes.map((s) => ({ userId: s.scopeRef, name: s.scopeName }));
  const from = teamRequestFrom(today);
  const reads = await Promise.all(people.map((p) => getActivitySeries(userId, tenant, { subjectUserId: p.userId, from })));
  const team = buildTeamActivity(people, reads, period);
  const periodLabel = team.from && team.to ? `${fmtDay(team.from)} to ${fmtDay(team.to)}` : TEAM_PERIODS.find((p) => p.key === period)!.label.toLowerCase();

  return (
    <>
      <PageHeader eyebrow="Analytics" title={heading} actions={change} />
      <div className="act">
        <nav className="act-period" aria-label="Period">
          {TEAM_PERIODS.map((p) => (
            <Link key={p.key} href={periodHref(unit, p.key)} className="act-period__link" aria-current={p.key === period ? "true" : undefined}>
              {p.label}
            </Link>
          ))}
        </nav>
        {people.length === 0 ? (
          <EmptyNote>Nobody is placed in this department.</EmptyNote>
        ) : (
          <Card>
            <TeamActivityTable
              rows={team.rows}
              unit={unit}
              caption={`Work done by kind, ${periodLabel}. People are listed by name. The counts are not a ranking and not a score, and activity alone is never used to judge a person.`}
            />
          </Card>
        )}
      </div>
    </>
  );
}
