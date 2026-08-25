import Link from "next/link";
import { formatDateRange } from "@/lib/reports";
import type { GmPeriodKind } from "@/lib/gm";

// The cockpit's freshness + provenance line. NOT decoration.
//
// This estate distinguishes SEALED report periods from live-computed ones, and stamps unsealed
// export artifacts `AD HOC · UNSEALED` for exactly this reason. A cockpit that renders a
// live-computed figure at the same visual weight as a sealed one is a correctness bug, not a polish
// gap — the GM would quote it in a review as the record.
//
// ⚠ The wording is constrained by what the endpoint actually returns. `ReportOverview` is
// `{periodKind, start, end, scopes}` — there is NO `sealed` flag and NO `generatedAt` on this read
// (unlike `ReportDocument`, whose `header` carries both). So this line must not claim a seal state
// in either direction, and must not claim a generation time it cannot know. It says the one true
// thing: this read does not carry seal state, and the document read is where the sealed record
// lives.
//
// `start`/`end` come from the RESPONSE, not from what the caller sent: for calendar period kinds the
// backend resolves the real period bounds from the anchor date, so echoing the request would print
// "23 Aug – 23 Aug" for a week.
export function GmProvenance({
  periodKind,
  start,
  end,
  documentHref,
  label,
}: {
  periodKind: GmPeriodKind;
  start: string;
  end: string;
  /** Where the sealed/authoritative record lives for this period. */
  documentHref: string;
  /** Overrides the "This week"/"This month" eyebrow. Required when the range is NOT the calendar
   *  period the toggle names — a TRAILING window ("last 7 days") labelled "This week" would be a
   *  lie about which days are counted. */
  label?: string;
}) {
  return (
    <p
      role="note"
      style={{
        margin: "0 0 16px", font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)",
        display: "flex", flexWrap: "wrap", gap: "0 8px", alignItems: "baseline",
      }}
    >
      <span style={{ font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-subtle)" }}>
        {label ?? (periodKind === "week" ? "This week" : "This month")}
      </span>
      <span>{formatDateRange(start, end)}</span>
      <span aria-hidden>·</span>
      {/* The honest limit, stated rather than implied. */}
      <span>Headline figures only; this read carries no seal state.</span>
      {/* Inline, not a `.lux-btn--ghost`: a 28px button in a 12px note out-weighs the provenance
          it sits beside. There is no site-wide `.lux-link` class to reach for. */}
      <Link href={documentHref} style={{ color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>
        Open the full report
      </Link>
    </p>
  );
}
