import { comparisonLabel, type ReportHeader } from "@/lib/reports";
import "./reports.css";

// "vs 16 Jun – 4 Jul" — never a bare "vs previous period" (§7 amendment: for
// an arbitrary custom span that label is meaningless, so the chip always
// names the actual baseline window).
export function ComparisonChip({ comparison }: { comparison: ReportHeader["comparison"] }) {
  const label = comparisonLabel(comparison);
  if (!label) return null;
  return <span className="rc-comparison-chip">{label}</span>;
}
