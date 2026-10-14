import Link from "next/link";
import type { DeptKpi } from "@/lib/deptKpiFormat";
import { conditionLabel, conditionTone } from "@/lib/deptKpiFormat";
import type { KpiDriversResult } from "@/lib/deptKpiDrivers";
import {
  DRIVERS_LOAD_ERROR, MAX_DRIVER_ROWS, driverHref, driverReading, driversListName, driversReasonText, noDriversStandOut,
} from "@/lib/deptKpiDriverFormat";
import { Card } from "@/components/ui";
import "./deptKpis.css";

// DW-4j-3 — "Behind the miss" (BFF §43.8): under the tiles, for each KPI that is at risk or off track, the projects or people the
// server names as the reason, worst first, at most five. Presentational: the page reads the drivers (`getKpiDrivers`, an honest reader) for
// the KPIs that need them, and only for a viewer who may see them (a head of the unit or the company-wide tier; a unit's staff never trigger
// the read and never see this block), and passes the entries in.
//
// Four honest states per KPI, never an empty claim for a failed read: the rows; "No one stands out" / "No project missed a milestone"
// for a read that succeeded with nothing in it (a TRUE statement); the reason in words when the KPI has no breakdown ("Not measured yet");
// and "Couldn't load what is behind this" for a failure. A refusal renders nothing for that KPI, and when nothing is left the whole block
// is absent (the page's own gate already speaks). The status colour is the existing `dk-badge` tone, and the condition is always also said in words.

export interface MissEntry {
  kpi: Pick<DeptKpi, "key" | "label" | "unit" | "condition">;
  result: KpiDriversResult;
}

function MissSection({ entry }: { entry: MissEntry }) {
  const { kpi, result } = entry;
  const tone = conditionTone(kpi.condition);
  let body;
  if (result.kind === "ok" && result.data.drivers !== null) {
    const rows = result.data.drivers.slice(0, MAX_DRIVER_ROWS);
    const period = result.data.period;
    body =
      rows.length === 0 ? (
        <p className="dk-target__meta">{noDriversStandOut(kpi.key)}</p>
      ) : (
        <ul className="dk-drivers" aria-label={driversListName(kpi.label)}>
          {rows.map((d) => {
            const { value, parts } = driverReading(kpi.key, kpi.unit, d);
            return (
              <li key={`${d.kind}:${d.id}`} className="dk-driver">
                <Link href={driverHref(d, period)} className="dk-driver__name">{d.name}</Link>
                {value !== null && <span className="dk-driver__value">{value}</span>}
                {parts && <span className="dk-driver__parts">{parts}</span>}
              </li>
            );
          })}
        </ul>
      );
  } else if (result.kind === "ok") {
    body = <p className="dk-target__meta">{driversReasonText(result.data.reason)}</p>;
  } else {
    body = <p className="dk-msg dk-msg--bad" role="status">{DRIVERS_LOAD_ERROR}</p>;
  }
  return (
    <section className="dk-miss">
      <div className="dk-miss__head">
        <h4 className="dk-target__name">{kpi.label}</h4>
        <span className={`dk-badge dk-badge--${tone}`}>{conditionLabel(kpi.condition)}</span>
      </div>
      {body}
    </section>
  );
}

/** The block under the tiles. Absent when there is no KPI to look behind, or when every read was refused. */
export function BehindTheMiss({ entries }: { entries: readonly MissEntry[] }) {
  const shown = entries.filter((e) => e.result.kind !== "forbidden");
  if (shown.length === 0) return null;
  return (
    <Card
      title="Behind the miss"
      hint="For each KPI that is at risk or off track, the projects or people that account for the miss in this period, worst first. Only the department's heads and the company-wide tiers see this."
    >
      {shown.map((e) => (
        <MissSection key={e.kpi.key} entry={e} />
      ))}
    </Card>
  );
}
