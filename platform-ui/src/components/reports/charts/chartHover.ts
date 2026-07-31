// Shared crosshair/tooltip math for the kit's line-family charts (TrendLine,
// Burndown, CumulativeFlow) — lifted out so the "nearest data position" and
// date-format logic is written once (interaction.md: "the crosshair finds
// the X... snaps to the nearest data position").
import type { PointerEvent as ReactPointerEvent } from "react";

export function nearestIndex(xs: number[], pct: number): number {
  let best = 0;
  let bestDist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(x - pct);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

export function pointerPct(e: ReactPointerEvent<SVGSVGElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  return ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
}

export function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}
