import Link from "next/link";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { listPositions } from "@/lib/iam";
import { getAppraisalCycles } from "@/lib/appraisals-data";
import { getCheckinCompliance } from "@/lib/checkins-data";
import { rollUpCompliance, type CheckinComplianceRow } from "@/lib/checkins";
import { listMembers } from "@/lib/entities";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getOrgStructure, flattenOrgUnits } from "@/lib/org";
import { parseGmPeriodKind, type GmPeriodKind } from "@/lib/gm";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";
import { GmProvenance } from "@/components/departments/gm/GmProvenance";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ period?: string }>;

const TITLE = "People";

// GM console → Oversight → People (GM-07).
//
// Three questions, three live reads, no new backend:
//   Do we have the people?      → `positions` (seats, and which are VACANT)
//   Are they showing up?        → `checkins/compliance` (the grid, rolled up)
//   Are they being appraised?   → `appraisals/cycles`
//
// ── VACANCIES ARE DATA, NOT AN ABSENCE ───────────────────────────────────────────────────────────
// The org chart carries unfilled seats as real `positions` rows with zero holders (platform-nest
// `seed/roster.ts`'s `VACANCIES` — "THESE ARE POSITIONS, NEVER PEOPLE"). So "3 open seats" is a
// fact read off the chart, not a subtraction between a headcount target and a roster. A vacant seat
// is `status === "active" && currentHolders === 0`; a RETIRED seat is not a vacancy and must not be
// counted as one, or every reorg inflates the number.
//
// ── THE COMPLIANCE READ HAS A SELF-ONLY FALLBACK, AND THAT IS A TRAP ─────────────────────────────
// `GET /checkins/compliance` does NOT 403 a plain member: TR-39's rule is that it degrades to a
// one-row grid of the caller. The GM console is gated well above that tier, so any principal who
// reaches this page should be getting the company-wide grid — but the console must not PRESENT a
// self-only grid as a team view if the tiers ever diverge. `unit` is echoed by the server (it
// rewrites the request for a unit-scoped caller), so the echo is what gets rendered, never the
// request.
//
// ── WHAT THIS TAB DOES NOT DO ────────────────────────────────────────────────────────────────────
// No leave-load figure. There is no leave-aggregate endpoint; leave only reaches this surface
// INDIRECTLY, as the reason a day is not "expected" in the compliance grid. Inventing a leave tile
// out of the compliance denominator would be a derived number pretending to be a measured one.
// Tracked as a gap in the foundation doc rather than faked here.

// There is no `.lux-kpis` container class in ui.css — `.lux-kpi` styles the tile itself and every
// caller lays the row out. A grid rather than the flex row `GoalDetailClient` uses: these tiles carry
// a `foot` line and a `hint`, so equal-width columns keep the three from ragged-wrapping.
const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16,
};

type Read<T> = { ok: true; data: T } | { ok: false; reason: "forbidden" | "unavailable" };

async function read<T>(p: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    const status = (e as { status?: number })?.status;
    return { ok: false, reason: status === 403 ? "forbidden" : "unavailable" };
  }
}

function pct(rate: number | null): string {
  // `null` is "nothing was expected", which is NOT 0%. Rendering it as a dash is the difference
  // between "no one was due" and "no one complied".
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function ReadNote({ subject }: { subject: string }) {
  return <EmptyNote>{subject} could not be read just now — a failed read, not an empty roster.</EmptyNote>;
}

export default async function GmPeoplePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { deptId } = await params;
  const ctx = await resolveGmTab(deptId);
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  const { period } = await searchParams;
  const periodKind: GmPeriodKind = parseGmPeriodKind(period);
  const anchor = new Date().toISOString().slice(0, 10);

  // ── WHY THIS READ USES A TRAILING WINDOW, NOT THE CALENDAR PERIOD ──────────────────────────────
  // MEASURED, not theorised: opening this tab on the first day of a calendar week returns an EMPTY
  // grid — "nobody was expected to check in during this period" — because the week has barely
  // started. Technically true, and useless: a GM asking "is the team showing up?" on a Monday
  // morning does not mean "since midnight".
  //
  // So compliance reads a TRAILING window ending today: 7 days for the week toggle, 30 for the
  // month. Every day in it has elapsed, so the figure is always answerable. This is the one place in
  // the console where the toggle does not select a calendar period, which is exactly why the
  // provenance line below is given an explicit `label` — calling a trailing 7 days "This week" would
  // misstate which days were counted.
  //
  // `custom` is the periodKind that expresses an arbitrary range; the controller requires `end` with
  // it and caps the span at 400 days, both of which this satisfies.
  const TRAILING_DAYS = periodKind === "week" ? 7 : 30;
  const complianceStart = new Date(Date.parse(`${anchor}T00:00:00Z`) - (TRAILING_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [positionsResult, cycles, compliance, members] = await Promise.all([
    // NOT wrapped in `read()`: `listPositions` catches its own errors and returns
    // `{positions: [], scope: null}`, so a refused read reaches us looking exactly like a company
    // with no seats. `scope === null` is the documented failure signal (lib/iam.ts) and is the only
    // thing that can tell the two apart — an empty list here would otherwise be a claim.
    listPositions(ctx.userId, ctx.tenantId),
    read(getAppraisalCycles(ctx.tenantId, ctx.userId)),
    read(getCheckinCompliance(ctx.tenantId, ctx.userId, {
      periodKind: "custom", start: complianceStart, end: anchor,
    })),
    listMembers(ctx.userId, ctx.tenantId).catch(() => []),
  ]);

  // A seat carries `unitNodeId`, not a unit NAME, and a GM-facing table full of `dept-1` is a table
  // nobody can read. Resolved against the same org structure the chart and the sidebar draw, so the
  // label here always matches what the unit is called everywhere else. A node id with no match
  // (an orphaned seat, which the backend flags separately) falls back to the raw id rather than
  // rendering blank — an unresolvable id is information, not nothing.
  const unitName = await (async () => {
    try {
      const me = await getMe(ctx.userId);
      const company = me.companies.find((c) => c.id === ctx.tenantId);
      if (!company) return (id: string) => id;
      const { structure } = await getOrgStructure(ctx.userId, ctx.tenantId, company);
      const byId = new Map(flattenOrgUnits(structure).map((u) => [u.id, u.name]));
      return (id: string) => byId.get(id) ?? id;
    } catch {
      return (id: string) => id;
    }
  })();

  const nameById = new Map(members.map((m) => [m.user_id, m.name]));
  const personLabel = (userId: string) => nameById.get(userId) ?? userId;

  // ── Seats ───────────────────────────────────────────────────────────────────────────────────────
  const positionsFailed = positionsResult.scope === null;
  const seats = positionsResult.positions;
  const activeSeats = seats.filter((s) => s.status === "active");
  const vacant = activeSeats.filter((s) => s.currentHolders === 0);
  const filledHeads = activeSeats.reduce((n, s) => n + s.currentHolders, 0);
  // `scope` is load-bearing on this read (see lib/iam.ts): a "tenant" scope means these are the
  // active company's seats, a "subtree" scope means the server narrowed them. Said out loud rather
  // than silently presented as the whole company.
  const seatScope = positionsResult.scope;

  // ── Compliance ──────────────────────────────────────────────────────────────────────────────────
  const grid: CheckinComplianceRow[] = compliance.ok ? compliance.data.rows : [];
  const roll = rollUpCompliance(grid);
  // Worst first: this tab exists to find the person who has stopped checking in, and sorting by
  // rate ascending puts them on the first row instead of alphabetically buried. `null` rates sort
  // LAST — an unknown rate cannot claim to be the worst.
  const ranked = [...grid].sort((a, b) => (a.complianceRate ?? 2) - (b.complianceRate ?? 2));

  // ── Appraisal cycles ────────────────────────────────────────────────────────────────────────────
  const cycleRows = cycles.ok ? cycles.data.cycles : [];
  const openCycles = cycleRows.filter((c) => c.status === "open" || c.status === "in_review");

  return (
    <>
      {compliance.ok && (
        <GmProvenance
          periodKind={periodKind}
          start={compliance.data.from}
          end={compliance.data.to}
          documentHref="/reports/department"
          label={`Last ${TRAILING_DAYS} days`}
        />
      )}

      <Card title="Headcount and seats" headerRight={
        <Link href="/organization/positions" className="lux-btn lux-btn--ghost lux-btn--sm">Positions</Link>
      }>
        {positionsFailed ? (
          <ReadNote subject="Seats" />
        ) : activeSeats.length === 0 ? (
          <EmptyNote>No active seats are defined for this company yet.</EmptyNote>
        ) : (
          <>
            <div style={KPI_ROW}>
              <KpiTile label="People in seats" value={String(filledHeads)} foot={`across ${activeSeats.length} active seat${activeSeats.length === 1 ? "" : "s"}`} />
              <KpiTile
                label="Open seats"
                value={String(vacant.length)}
                foot={vacant.length ? "unfilled positions on the chart" : "every seat is filled"}
                hint="An active position with no current holder. Retired positions are not counted — a reorg should not read as a hiring gap."
              />
              <KpiTile label="Lead seats" value={String(activeSeats.filter((s) => s.isLead).length)} foot="units with a designated lead" />
            </div>
            {vacant.length > 0 && (
              <HairlineTable
                columns={[{ label: "Open seat" }, { label: "Unit" }, { label: "Lead", align: "right" }]}
                rows={vacant.map((s) => [s.title, unitName(s.unitNodeId), s.isLead ? "yes" : "—"])}
                tcols="2fr 1.4fr 0.6fr"
              />
            )}
            {seatScope === "subtree" && (
              <p style={{ margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
                These are the seats below your own unit, not the whole company — the server narrowed this read.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="Check-in compliance">
        {!compliance.ok ? (
          <ReadNote subject="Compliance" />
        ) : grid.length === 0 ? (
          <EmptyNote>
            Nobody was expected to check in over the last {TRAILING_DAYS} days — every day in the
            window was a non-working day, or nobody was employed in it.
          </EmptyNote>
        ) : (
          <>
            <div style={KPI_ROW}>
              <KpiTile
                label="Submitted"
                value={pct(roll.rate)}
                foot={`${roll.submitted}/${roll.expected} expected days`}
                hint="Submitted days over expected days across everyone, not an average of per-person rates — averaging would weight one expected day the same as twenty."
              />
              <KpiTile label="Missed days" value={String(roll.missed)} foot={`across ${roll.people} ${roll.people === 1 ? "person" : "people"}`} />
              <KpiTile label="Excused" value={String(roll.excused)} foot="approved by a lead or HR" />
            </div>
            <HairlineTable
              columns={[{ label: "Person" }, { label: "Expected", align: "right" }, { label: "Submitted", align: "right" }, { label: "Missed", align: "right" }, { label: "Rate", align: "right" }]}
              rows={ranked.map((r) => [
                personLabel(r.userId),
                String(r.expectedDays),
                String(r.submittedDays),
                String(r.missedDays),
                pct(r.complianceRate),
              ])}
              tcols="2fr repeat(4, 1fr)"
            />
            {compliance.data.unit !== null && (
              <p style={{ margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
                Scoped to unit <code>{compliance.data.unit}</code> by the server, not to the whole company.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="Appraisal cycles" headerRight={
        <Link href="/appraisals/cycles" className="lux-btn lux-btn--ghost lux-btn--sm">Cycles</Link>
      }>
        {!cycles.ok ? (
          <ReadNote subject="Appraisal cycles" />
        ) : cycleRows.length === 0 ? (
          <EmptyNote>No appraisal cycle has been created yet.</EmptyNote>
        ) : (
          <>
            <HairlineTable
              columns={[{ label: "Cycle" }, { label: "Period" }, { label: "Status", align: "right" }]}
              rows={cycleRows.map((c) => [c.name, `${c.periodStart} → ${c.periodEnd}`, c.status.replace(/_/g, " ")])}
              tcols="2fr 1.6fr 0.8fr"
            />
            {openCycles.length === 0 && (
              <p style={{ margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
                No cycle is currently open or in review.
              </p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
