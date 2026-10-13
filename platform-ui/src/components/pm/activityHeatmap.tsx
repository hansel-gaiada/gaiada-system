import "./productivity.css";

// The year heatmap's cell rules, shared (DW-3j): the intensity bucket, the weekday and date formatters and the
// legend. Productivity.tsx's `Heatmap` and the Overview's "My activity" both draw with these, so a shade means
// the same thing in both. Deliberately NOT "use client": the Overview's block is a server component and calls
// these directly (a function exported from a client module is not callable from a server one).
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** Monday-first weekday of an ISO date: 0 = Monday. */
export function isoWeekday(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}
export function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
export function monthShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
}

/** The shade of a day: relative to the person's own busiest day in the range, so the ramp reads whether the
 *  range holds a few days or a year. */
export function levelFor(total: number, max: number): HeatLevel {
  if (total <= 0 || max <= 0) return 0;
  const pct = total / max;
  if (pct > 0.75) return 4;
  if (pct > 0.5) return 3;
  if (pct > 0.25) return 2;
  return 1;
}

export function HeatmapLegend() {
  return (
    <div className="prod-heatmap__legend" aria-hidden>
      <span>Less</span>
      {[0, 1, 2, 3, 4].map((l) => <span key={l} className="prod-heatmap__swatch" data-level={l} />)}
      <span>More</span>
    </div>
  );
}
