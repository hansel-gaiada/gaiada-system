"use client";
import { useState } from "react";
import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";

// Check-in compliance calendar (person grain, §7's per-grain chart table).
// NOTE on the prop shape: §6.1's ReportDocument has no bespoke "compliance
// calendar" type — check-in compliance is served by its own endpoint
// (`GET /api/:t/checkins/compliance`, §6.2), a separate data source from the
// report document. `CheckinDay` here is a minimal, provisional shape matching
// that endpoint's described fields (expected/submitted/missed/excused); it
// isn't a §6.1 contract type, so TR-17/TR-09 should confirm it against the
// real endpoint response once wired rather than treat it as frozen.
export type CheckinDayStatus = "submitted" | "missed" | "excused" | "not_expected";
export interface CheckinDay { date: string; status: CheckinDayStatus }

const STATUS_COLOR: Record<CheckinDayStatus, string> = {
  submitted: "var(--rc-good)",
  missed: "var(--rc-critical)",
  excused: "var(--rc-warning)",
  not_expected: "var(--rc-grid)",
};
const STATUS_LABEL: Record<CheckinDayStatus, string> = {
  submitted: "Submitted", missed: "Missed", excused: "Excused", not_expected: "Not expected",
};

function isoWeekday(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function CalendarHeatmap({ days, title = "Check-in compliance" }: { days: CheckinDay[]; title?: string }) {
  if (days.length === 0) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>No check-in history yet.</p>;
  }
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  // pad the first column to line the first day up under its real weekday row.
  const leadingBlanks = isoWeekday(sorted[0].date);
  const cells: (CheckinDay | null)[] = [...Array(leadingBlanks).fill(null), ...sorted];

  const expected = sorted.filter((d) => d.status !== "not_expected").length;
  const submitted = sorted.filter((d) => d.status === "submitted").length;
  const rate = expected > 0 ? Math.round((submitted / expected) * 100) : null;

  const [hover, setHover] = useState<CheckinDay | null>(null);

  return (
    <div className="rc-viz">
      <div className="rc-heatmap">
        <div className="rc-kpi__foot" style={{ margin: 0 }}>
          {rate !== null ? <><strong>{submitted}/{expected}</strong> expected days submitted ({rate}%)</> : "No expected days in range."}
        </div>
        <div
          className="rc-heatmap__grid" role="img"
          aria-label={`${title}: ${submitted} of ${expected} expected days submitted`}
        >
          {cells.map((c, i) => (
            c === null
              ? <span key={`blank-${i}`} className="rc-heatmap__cell" style={{ visibility: "hidden" }} aria-hidden />
              : (
                <button
                  key={c.date}
                  type="button"
                  className="rc-heatmap__cell"
                  style={{ background: STATUS_COLOR[c.status] }}
                  aria-label={`${fmtDate(c.date)}: ${STATUS_LABEL[c.status]}`}
                  onMouseEnter={() => setHover(c)}
                  onFocus={() => setHover(c)}
                  onMouseLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                />
              )
          ))}
        </div>
        <div className="rc-heatmap__legend" role="list" aria-label="Status">
          {(Object.keys(STATUS_LABEL) as CheckinDayStatus[]).map((s) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} role="listitem">
              <span className="rc-heatmap__swatch" style={{ background: STATUS_COLOR[s] }} aria-hidden />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
        {hover && <div className="rc-kpi__foot" role="status" style={{ margin: 0 }}><strong>{fmtDate(hover.date)}</strong>: {STATUS_LABEL[hover.status]}</div>}
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Date", "Status"]}
        rows={sorted.map((d) => [fmtDate(d.date), STATUS_LABEL[d.status]])}
      />
    </div>
  );
}
