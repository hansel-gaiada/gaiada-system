import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { KpiTiles } from "@/components/reports/charts/KpiTiles";
import { getReportOverview, isForbidden, isRangeTooLarge } from "@/lib/reports-data";
import type { ReportOverview, ReportOverviewScope } from "@/lib/reports-data";
import { GM_PERIOD_KINDS, GM_TIER1_LIMIT, GM_NARROWED_NOTICE, type GmAccess, type GmPeriodKind } from "@/lib/gm";
import { GmProvenance } from "./GmProvenance";
import { GmMoneyCard } from "./GmMoneyCard";
import { GmMonitoringCard } from "./GmMonitoringCard";
import { GmDeptStrip } from "./GmDeptStrip";

// The GM cockpit — Home of the GM console (GM-03).
// Design: `docs/blueprints/gm-console-foundation.md` §4.
//
// Three tiers, and the third one is not built here on purpose:
//   Tier 1 — company-grain headline KPIs (`reports/overview`, `grain=company`).
//   Tier 2 — one row per department (`reports/overview`, `grain=department`).
//   Tier 3 — the existing app. Every figure links to the page that already owns it. This component
//            must never become a second implementation of the department console; it is an INDEX
//            over it, which is the whole reason the foundation doc refused to relocate routes.
//
// ── WHY THE TILES ARE NOT A HANDPICKED NORTH-STAR LIST ───────────────────────────────────────────
// The design sketched six named north stars ("on-time delivery", "blocked work", …). Implementing
// that literally would mean hardcoding metric keys against a registry this console does not own —
// the exact frontend-first drift that keeps producing confident wrong answers here. `reports/overview`
// IS the backend's curated headline set for the grain (its own contract calls it the "console
// landing"), and `document.kpis` order is authored per grain, so the leading entries ARE the
// headline ones. So: render what the registry returns, capped at `GM_TIER1_LIMIT`, and say when
// there is more behind the cap. The tile treatment, formatting, denominators, point-in-time labels
// and delta chips all come from `KpiTiles`, reused as-is — no adapter, nothing to drift.
//
// ── FAILURE HANDLING: A FAILED READ AND AN EMPTY ONE ARE DIFFERENT FACTS ─────────────────────────
// Each tier degrades on its own (the rule the department Home already follows), but NOT to `[]`.
// An empty list is a CLAIM — "this business did nothing this week" — and collapsing a 403 or a dead
// endpoint into it is how a console ends up lying quietly. So each read resolves to a tagged result
// and the three outcomes render differently: refused, unavailable, or genuinely empty.

type Tier<T> =
  | { state: "ok"; data: T }
  | { state: "forbidden" }
  | { state: "range" }
  | { state: "unavailable" };

async function readOverview(
  tenantId: string,
  userId: string,
  grain: "company" | "department",
  periodKind: GmPeriodKind,
  anchor: string,
): Promise<Tier<ReportOverview>> {
  try {
    // `end` is sent because the client always sends it; the controller ignores it for calendar
    // period kinds and derives the real bounds from `start`. That is why the provenance line below
    // reads the range back off the RESPONSE rather than echoing what went out.
    const data = await getReportOverview(tenantId, userId, { grain, periodKind, start: anchor, end: anchor });
    return { state: "ok", data };
  } catch (e) {
    if (isForbidden(e)) return { state: "forbidden" };
    if (isRangeTooLarge(e)) return { state: "range" };
    return { state: "unavailable" };
  }
}

function periodHref(deptId: string, kind: GmPeriodKind): string {
  return `/departments/${deptId}?period=${kind}`;
}

function PeriodToggle({ deptId, active }: { deptId: string; active: GmPeriodKind }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {GM_PERIOD_KINDS.map((kind) => (
        <Link
          key={kind}
          href={periodHref(deptId, kind)}
          aria-current={kind === active ? "true" : undefined}
          className={`lux-btn lux-btn--sm ${kind === active ? "lux-btn--solid" : "lux-btn--ghost"}`}
        >
          {kind === "week" ? "Week" : "Month"}
        </Link>
      ))}
    </div>
  );
}

/** The one place the three non-ok tiers turn into prose. Kept together so the wording cannot drift
 *  apart between Tier 1 and Tier 2 — the reader must be able to tell "not yours" from "not working"
 *  from "nothing happened". */
function TierNote({ tier, subject }: { tier: Exclude<Tier<unknown>, { state: "ok" }>; subject: string }) {
  if (tier.state === "forbidden") {
    return <EmptyNote>{subject} are limited to group executives, and this account is not one.</EmptyNote>;
  }
  if (tier.state === "range") {
    return <EmptyNote>The selected period is too long for {subject.toLowerCase()} to be computed.</EmptyNote>;
  }
  return <EmptyNote>{subject} could not be read just now. This is a failed read, not an empty business.</EmptyNote>;
}

export async function GmCockpit({
  userId,
  tenantId,
  deptId,
  periodKind,
  anchorDate,
  access,
  canReadMoney,
}: {
  userId: string;
  tenantId: string;
  deptId: string;
  periodKind: GmPeriodKind;
  /** "full" gets the company tier; "narrowed" (a department lead — GM-02b) does not. */
  access: Exclude<GmAccess, "none">;
  /** GM-09. A SEPARATE boundary from `access`: finance is its own Cerbos resource and its own
   *  per-tenant module, so a narrowed lead who legitimately reads department reports must not
   *  thereby read the company's P&L. */
  canReadMoney: boolean;
  /** Today, as ISO. Passed in rather than read from a clock here: the page resolves it once so
   *  every tier of one render shares an anchor. */
  anchorDate: string;
}) {
  // A narrowed principal does not get the company read AT ALL — not requested, not requested-and-
  // discarded. Firing it would put a guaranteed 403 in the server log on every page view and invite a
  // future refactor to "helpfully" render whatever came back.
  const [company, depts] = await Promise.all([
    access === "full"
      ? readOverview(tenantId, userId, "company", periodKind, anchorDate)
      : Promise.resolve<Tier<ReportOverview>>({ state: "forbidden" }),
    readOverview(tenantId, userId, "department", periodKind, anchorDate),
  ]);

  // The company grain resolves to exactly one scope (the tenant itself — the controller requires
  // `scopeRef === tenantId` at this grain), so there is no scope to pick.
  const companyScope: ReportOverviewScope | undefined =
    company.state === "ok" ? company.data.scopes[0] : undefined;
  const companyKpis = companyScope?.kpis ?? [];
  const tier1 = companyKpis.slice(0, GM_TIER1_LIMIT);
  const tier1Hidden = companyKpis.length - tier1.length;

  const provenance =
    company.state === "ok" ? company.data : depts.state === "ok" ? depts.data : null;

  // The money window follows whatever period the cockpit is showing, so revenue and the department
  // figures above it describe the same days. Falls back to the anchor when neither read answered —
  // a same-day window is a true (if narrow) statement, where inventing a month would not be.
  const moneyFrom = provenance?.start ?? anchorDate;
  const moneyTo = provenance?.end ?? anchorDate;

  return (
    <>
      {access === "narrowed" && (
        // Stated, never implied. A department-scoped number under an unqualified heading is exactly
        // the misreading this console is built to prevent.
        <p role="note" style={{
          margin: "0 0 16px", font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)",
          border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-accent)",
          background: "var(--tint-hover)", padding: "12px 14px",
        }}>
          {GM_NARROWED_NOTICE}
        </p>
      )}
      {/* Provenance comes from whichever read actually answered. A narrowed reader has no company
          read at all, so echoing `company.data` would drop the line entirely — and the period +
          "no seal state" caveat matter just as much at department grain. */}
      {provenance && (
        <GmProvenance
          periodKind={periodKind}
          start={provenance.start}
          end={provenance.end}
          documentHref={access === "full" ? "/reports/company" : "/reports/department"}
        />
      )}

      {access === "narrowed" ? null : (
      <Card title="The business" headerRight={<PeriodToggle deptId={deptId} active={periodKind} />}>
        {company.state !== "ok" ? (
          <TierNote tier={company} subject="Company figures" />
        ) : tier1.length === 0 ? (
          <EmptyNote>No company figures for this period yet.</EmptyNote>
        ) : (
          <>
            <KpiTiles kpis={tier1} />
            {tier1Hidden > 0 && (
              <p style={{ margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
                {tier1Hidden} further compan{tier1Hidden === 1 ? "y metric" : "y metrics"} sit behind{" "}
                <Link href="/reports/company" style={{ color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>
                  the company report
                </Link>
                .
              </p>
            )}
          </>
        )}
      </Card>
      )}

      <Card
        title="Departments"
        headerRight={
          // The toggle normally rides the company card. A narrowed reader has no company card, so it
          // moves here — otherwise they would have no way to switch period at all, and the `?period=`
          // URL would be the only route to a month view.
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {access === "narrowed" && <PeriodToggle deptId={deptId} active={periodKind} />}
            <Link href={`/departments/${deptId}/depts?period=${periodKind}`} className="lux-btn lux-btn--ghost lux-btn--sm">
              All metrics
            </Link>
          </div>
        }
      >
        {depts.state !== "ok" ? (
          <TierNote tier={depts} subject="Department figures" />
        ) : (
          <GmDeptStrip
            scopes={depts.data.scopes}
            limit={4}
            // Tier 3: drill into the department's own REPORT, which is the surface that owns these
            // exact numbers at that grain. The department CONSOLE is a click further on from there.
            hrefFor={(scopeRef) =>
              `/reports/department?${new URLSearchParams({
                periodKind,
                start: depts.data.start,
                end: depts.data.end,
                scopeRef,
              }).toString()}`
            }
          />
        )}
      </Card>

      {/* Client monitoring sits with the OPERATING tiers, above money: it is an input signal about
          work already sold, not a financial outcome. Ungated deliberately — `monitoring.read` on the
          backend is the boundary and the sidebar row is ungated for the same reason, so a narrowed
          department lead sees it too. Plane B only; our own infrastructure is not in the ERP. */}
      <GmMonitoringCard userId={userId} tenantId={tenantId} />

      {/* Money LAST, below both operating tiers — the operating-cadence rule this console follows
          puts financial metrics at the end of the deck, after the input and output metrics that
          explain them. It first shipped between the two tiers by mistake; the e2e ordering assertion
          caught it, which is exactly why that assertion is on headings and not on prose.

          `explainRefusal={false}` — a GM without finance access gets NO card rather than a permanent
          refusal notice on their home screen. The money TAB passes true, because that is the surface
          where the question was actually asked. */}
      {canReadMoney && (
        <GmMoneyCard
          userId={userId}
          tenantId={tenantId}
          from={moneyFrom}
          to={moneyTo}
          variant="compact"
          explainRefusal={false}
        />
      )}
    </>
  );
}
