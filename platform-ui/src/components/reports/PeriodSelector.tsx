"use client";
import { useState } from "react";
import type { ReportPeriodKind } from "@/lib/reports";
import { buildPresetRanges, dayCountOf, REPORT_MAX_CUSTOM_DAYS } from "@/lib/reports";
import "./reports.css";

export interface PeriodSelectorValue { kind: ReportPeriodKind; start: string; end: string }

// The one shared control every grain's report surface carries (§7 amendment):
// Daily · Weekly · Monthly · Custom range, where Custom opens a date-range
// picker with presets. This component only emits the NEXT {kind,start,end}
// via onChange — it never fetches; the caller (a grain page, TR-17) owns
// re-fetching the document for the new range. `todayIso` is passed in
// (server-resolved REPORTS_TZ "today") rather than read from the client
// clock, so presets stay correct under the deployment's reporting timezone.
export function PeriodSelector({ value, onChange, todayIso }: {
  value: PeriodSelectorValue;
  onChange: (next: PeriodSelectorValue) => void;
  todayIso: string;
}) {
  const [open, setOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState(value.start);
  const [pendingEnd, setPendingEnd] = useState(value.end);
  const presets = buildPresetRanges(todayIso);

  const selectKind = (kind: Exclude<ReportPeriodKind, "custom">) => {
    setOpen(false);
    // Daily/Weekly/Monthly re-anchor on "today" — the calling page resolves
    // the exact calendar boundary server-side the same way it always has;
    // this control only signals intent, per its no-hidden-fetching contract.
    onChange({ kind, start: todayIso, end: todayIso });
  };

  const applyPreset = (start: string, end: string) => {
    onChange({ kind: "custom", start, end });
    setOpen(false);
  };

  const dayCount = dayCountOf(pendingStart, pendingEnd);
  const tooLarge = dayCount > REPORT_MAX_CUSTOM_DAYS;
  const invalid = pendingEnd < pendingStart;

  const applyCustom = () => {
    if (invalid || tooLarge) return;
    onChange({ kind: "custom", start: pendingStart, end: pendingEnd });
    setOpen(false);
  };

  return (
    <div className="rc-period">
      <div className="rc-period__kinds" role="group" aria-label="Report period">
        {(["day", "week", "month"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`rc-period__kind${value.kind === k ? " rc-period__kind--active" : ""}`}
            aria-pressed={value.kind === k}
            onClick={() => selectKind(k)}
          >
            {k === "day" ? "Daily" : k === "week" ? "Weekly" : "Monthly"}
          </button>
        ))}
        <button
          type="button"
          className={`rc-period__kind${value.kind === "custom" ? " rc-period__kind--active" : ""}`}
          aria-pressed={value.kind === "custom"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Custom range
        </button>
      </div>
      {open && (
        <div className="rc-period__pop" role="dialog" aria-label="Choose a date range">
          <div className="rc-period__presets">
            {presets.map((p) => {
              const active = value.kind === "custom" && value.start === p.start && value.end === p.end;
              return (
                <button
                  key={p.label}
                  type="button"
                  className={`rc-period__preset${active ? " rc-period__preset--active" : ""}`}
                  onClick={() => applyPreset(p.start, p.end)}
                >
                  <span className="rc-period__preset-check" aria-hidden>{active ? "✓" : ""}</span>
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="rc-period__custom">
            <label className="rc-period__field">
              <span>Start</span>
              <input type="date" value={pendingStart} max={todayIso} onChange={(e) => setPendingStart(e.target.value)} />
            </label>
            <label className="rc-period__field">
              <span>End</span>
              <input type="date" value={pendingEnd} onChange={(e) => setPendingEnd(e.target.value)} />
            </label>
            <button type="button" className="rc-period__apply" onClick={applyCustom} disabled={invalid || tooLarge}>
              Apply
            </button>
          </div>
          {invalid && <p className="rc-period__error">End date must be on or after the start date.</p>}
          {!invalid && tooLarge && (
            <p className="rc-period__error">Range is {dayCount} days — the maximum custom range is {REPORT_MAX_CUSTOM_DAYS} days.</p>
          )}
        </div>
      )}
    </div>
  );
}
