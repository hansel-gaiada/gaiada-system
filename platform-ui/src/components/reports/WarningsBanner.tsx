import type { ReportHeader } from "@/lib/reports";
import "./reports.css";

// §7 amendment: "silence here is a lie of omission" — a user-chosen range
// straddles these constantly (ad-hoc/unsealed, partial period, ends-in-
// future, precedes-fact-history, spans-membership-change), so every set flag
// on `header.warnings` renders, always, above the charts — never a dismissed
// toast, never collapsed by default.
export function WarningsBanner({ header }: { header: ReportHeader }) {
  const w = header.warnings;
  if (!w) return null;
  const items: { text: string; tone: "info" | "risk" }[] = [];
  if (w.adHoc) {
    items.push({ tone: "info", text: "Ad hoc · unsealed — this custom range is a live computation, not the authoritative sealed record, and can't be used for appraisal." });
  }
  if (w.partialPeriod) {
    items.push({ tone: "info", text: "Partial period — this range cuts across an incomplete week or month." });
  }
  if (w.endsInFuture) {
    items.push({ tone: "info", text: "Ends in the future — trailing days have no data yet (shown as a gap in the trend, never faked as zero)." });
  }
  if (w.precedesFactHistory) {
    items.push({ tone: "risk", text: `Precedes fact history — data only exists from ${w.precedesFactHistory.firstFactDate}; ${w.precedesFactHistory.affectedDays} day(s) at the start of this range have no facts.` });
  }
  if (w.spansMembershipChange) {
    items.push({ tone: "risk", text: "Spans a membership change — this subject moved unit partway through the range, so department totals may be split across units." });
  }
  if (items.length === 0) return null;
  return (
    <div className="rc-warnings" role="status">
      {items.map((it, i) => (
        <div key={i} className={`rc-warning rc-warning--${it.tone}`}>
          <span className="rc-warning__glyph" aria-hidden>!</span>
          {it.text}
        </div>
      ))}
    </div>
  );
}
