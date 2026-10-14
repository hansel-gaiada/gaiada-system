import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, canInUnit, unitPathOf } from "@/lib/rbac";
import { readOrgRoot } from "@/lib/campaigns-data";
import {
  bannerSentence, conditionLabel, conditionTone, formatKpiValue, formatMonth, formatTolerance, getDeptKpis, getDeptKpiTargets,
  ratioParts, tileFoot, type DeptKpiTargetRow, type DeptKpiTargetsKpi, type DeptKpiTargetsView, type DeptKpisView,
} from "@/lib/deptKpis";
import type { ReportPeriodKind } from "@/lib/reports";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import { ReportPeriodBar } from "@/components/reports/ReportPeriodBar";
import { ProposeTargetForm, DecideButtons } from "@/components/deptkpis/TargetControls";
import "@/components/deptkpis/deptKpis.css";

const TITLE = "Department";
const DENIED = "A department's KPIs are limited to the people in it, its heads, and the company-wide tiers (reporting blueprint §8).";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Appraisals > Department (DW-4e-2, BFF §40, plan §5.3 and §5.5). Opens for ONE department (`?unit=`) from its
// workspace: the condition banner, one tile per KPI in catalogue order, and, for a head or the approver, the targets
// screen where a head proposes a target and the approver approves it.
//
// Honest by construction: values, targets and conditions come from `GET dept-kpis` and nowhere else, a refused,
// missing or failed read is said as such and never rendered as tiles, and a KPI with no reader or no target says so
// in words rather than showing a number it does not have. The server stays the authority on every action; the
// buttons here only mirror `reports.dept_kpi_target.*` so a viewer is not offered what the server will refuse.
// Staff of the department read the tiles and the banner and nothing else (plan §5.5: no ranking, no targets screen).
export default async function DepartmentKpiPage({
  searchParams,
}: {
  searchParams: Promise<{ unit?: string | string[]; periodKind?: string; start?: string; end?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const unit = typeof sp.unit === "string" && sp.unit !== "" ? sp.unit : null;

  if (unit === null) {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title={TITLE} />
        <EmptyNote>
          This page opens from a department workspace. Choose a department on <Link href="/departments">Departments</Link>,
          then open Performance &rsaquo; Appraisals &rsaquo; Department.
        </EmptyNote>
      </>
    );
  }

  const today = todayIso();
  const periodKind = sp.periodKind ?? "month";
  const start = sp.start ?? today;
  const end = sp.end;

  const res = await getDeptKpis(userId, tenant, { unit, periodKind, start, ...(end ? { end } : {}) });
  if (res.kind === "forbidden") {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title={TITLE} />
        <ReportAccessDenied reason={DENIED} />
      </>
    );
  }
  if (res.kind === "not_found") {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title={TITLE} />
        <EmptyNote>This department does not exist.</EmptyNote>
      </>
    );
  }
  if (res.kind === "error") {
    return (
      <>
        <PageHeader eyebrow="Appraisals" title={TITLE} />
        <ReadRefusal subject="This department's KPIs" kind="unavailable" reason={res.reason} />
      </>
    );
  }
  const view: DeptKpisView = res.data;

  // The target actions. A head's grant is unit-scoped, so company-wide `can()` never counts it: ask `canInUnit` over the
  // unit's path in the org tree (when the tree cannot be read only a company-wide holder passes). Approving is the
  // company_admin tier, company-wide, and never one's own proposal. The server decides all of it again.
  const root = await readOrgRoot(me, tenant);
  const canPropose =
    can(me, "reports.dept_kpi_target.propose", tenant) ||
    canInUnit(me, "reports.dept_kpi_target.propose", tenant, root ? unitPathOf(root, unit) : []);
  const canApprove = can(me, "reports.dept_kpi_target.approve", tenant);

  const targets = canPropose || canApprove ? await getDeptKpiTargets(userId, tenant, unit) : null;

  const tone = conditionTone(view.condition);
  return (
    <>
      <PageHeader eyebrow="Appraisals" title={`${view.unit.name} · ${TITLE}`} />
      <ReportPeriodBar
        value={{ kind: view.period.periodKind as ReportPeriodKind, start: view.period.start, end: view.period.end }}
        todayIso={today}
      />

      <section className={`dk-banner dk-banner--${tone}`} aria-label="Department condition">
        <span className={`dk-badge dk-badge--${tone}`}>{conditionLabel(view.condition)}</span>
        <span>{bannerSentence(view)}</span>
      </section>

      {view.kpis.length === 0 ? (
        <EmptyNote>This department has no KPIs defined yet.</EmptyNote>
      ) : (
        <ul className="dk-tiles" aria-label="KPIs" style={{ listStyle: "none", padding: 0 }}>
          {view.kpis.map((k) => {
            const kt = conditionTone(k.condition);
            const parts = ratioParts(k);
            return (
              <li key={k.key} className={`dk-tile dk-tile--${kt}`}>
                <span className="dk-tile__label">{k.label}</span>
                <span className="dk-tile__value">{formatKpiValue(k.value, k.unit)}</span>
                <span className={`dk-badge dk-badge--${kt}`}>
                  {conditionLabel(k.condition)}
                </span>
                <span className="dk-tile__foot">{tileFoot(k)}</span>
                {parts && <span className="dk-tile__foot">{parts}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {targets !== null && (
        <TargetsSection
          unit={unit}
          result={targets}
          meId={me.userId}
          canPropose={canPropose}
          canApprove={canApprove}
        />
      )}
    </>
  );
}

function who(row: DeptKpiTargetRow, meId: string): string {
  return row.proposedBy === meId ? "you" : row.proposedBy;
}

function TargetsSection({
  unit, result, meId, canPropose, canApprove,
}: {
  unit: string;
  result: Awaited<ReturnType<typeof getDeptKpiTargets>>;
  meId: string;
  canPropose: boolean;
  canApprove: boolean;
}) {
  if (result.kind !== "ok") {
    // The tiles above are real; only the targets read failed, so say that and nothing more.
    if (result.kind === "forbidden") return <ReadRefusal subject="this department's targets" kind="forbidden" />;
    if (result.kind === "not_found") return <EmptyNote>This department does not exist.</EmptyNote>;
    return <ReadRefusal subject="This department's targets" kind="unavailable" reason={result.reason} />;
  }
  const data: DeptKpiTargetsView = result.data;
  return (
    <Card
      title="Targets"
      hint="A head proposes a target; the approver approves it. A newer proposal changes nothing until it is approved, so the target in force keeps governing until then. Targets are levels: one target applies to a month, a quarter, a semester or a year."
    >
      {data.kpis.length === 0 ? (
        <EmptyNote>This department has no KPIs to set targets for.</EmptyNote>
      ) : (
        data.kpis.map((k) => (
          <TargetRow key={k.key} unit={unit} kpi={k} asOf={data.asOf} meId={meId} canPropose={canPropose} canApprove={canApprove} />
        ))
      )}
    </Card>
  );
}

function TargetRow({
  unit, kpi, asOf, meId, canPropose, canApprove,
}: {
  unit: string;
  kpi: DeptKpiTargetsKpi;
  asOf: string;
  meId: string;
  canPropose: boolean;
  canApprove: boolean;
}) {
  const f = kpi.inForce;
  return (
    <div className="dk-target">
      <div className="dk-target__head">
        <h4 className="dk-target__name">{kpi.label}</h4>
        <p className="dk-target__meta">
          {f
            ? `Target ${formatKpiValue(f.target, kpi.unit)}, tolerance ${formatTolerance(f.tolerance, kpi.unit)}, in force from ${formatMonth(f.effectiveFrom)}`
            : "No target"}
        </p>
      </div>
      {kpi.proposals.map((p) => {
        const own = p.proposedBy === meId;
        return (
          <div key={p.id} className="dk-target__actions">
            <p className="dk-target__meta" style={{ margin: 0 }}>
              Proposed: {formatKpiValue(p.target, kpi.unit)}, tolerance {formatTolerance(p.tolerance, kpi.unit)}, from{" "}
              {formatMonth(p.effectiveFrom)}. By {who(p, meId)} on {p.proposedAt.slice(0, 10)}.
              {p.note ? ` Note: ${p.note}` : ""}
            </p>
            {canApprove && !own && <DecideButtons id={p.id} kpiLabel={kpi.label} />}
            {own && <span className="dk-target__meta">You proposed this, so someone else decides it.</span>}
          </div>
        );
      })}
      {canPropose && (
        <div className="dk-target__actions">
          <ProposeTargetForm unitId={unit} kpi={kpi} asOf={asOf} />
        </div>
      )}
    </div>
  );
}
