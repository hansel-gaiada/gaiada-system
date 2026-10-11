// PV1-06b — the group report's contract types and the pure rendering rules for the Group pages.
// Mirrors `platform-nest/src/modules/reports/group-report.ts` (the BFF contract row for
// `GET /api/:rootId/reports/group`). NOT `"server-only"`: the types and helpers are shared by the
// server pages and the unit tests, and the fetch itself lives in `reports-data.ts`.
//
// THE RULES THIS FILE HOLDS, because they are what makes the page honest rather than merely pretty:
//   - A company whose `figures` is null has no Company Report to read (its `reports` module is off).
//     It shows the module-off text, NEVER zeros: zeros would claim the company did nothing.
//   - A sum is shown only for a figure the server marked additive on every card. A ratio is never
//     presented as a sum or an average, even if a (buggy or older) backend sent one: the UI drops it.
//   - `consolidated` is null until F9 eliminations exist; the page renders the reason, not a number.
import type { ReportPeriodKind, ReportUnit } from "./reports";

export interface GroupFigure {
  metricKey: string;
  label: string;
  unit: ReportUnit;
  value: number;
  numerator?: number;
  denominator?: number;
  additive: boolean;
}

export interface GroupCompanyCard {
  companyId: string;
  name: string;
  vertical: string;
  figures: GroupFigure[] | null;
  figuresUnavailable?: "reports_module_not_enabled";
}

export interface GroupSum {
  metricKey: string;
  label: string;
  unit: ReportUnit;
  value: number;
  companyCount: number;
}

export interface GroupReport {
  rootCompanyId: string;
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
  companies: GroupCompanyCard[];
  sumOfCompanies: GroupSum[];
  consolidated: null;
  consolidatedReason: string;
}

export const MODULE_OFF_TEXT = "Report module off for this company";

/** A figure is a ratio when it carries its parts (invariant 2 of the report contract) or is a percent. */
export function isRatioFigure(f: Pick<GroupFigure, "unit" | "numerator" | "denominator">): boolean {
  return f.unit === "percent" || (f.numerator !== undefined && f.denominator !== undefined);
}

/** "agency" -> "Agency". A missing vertical reads as "General", like the rest of the UI. */
export function verticalLabel(vertical: string | null | undefined): string {
  const v = (vertical ?? "").trim() || "general";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/** The value with its unit: percent as a whole percent, minutes as "N min", counts as a plain number. */
export function formatFigureValue(unit: ReportUnit, value: number): string {
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return `${Math.round(value).toLocaleString("en-US")} min`;
  return value.toLocaleString("en-US");
}

/** "4/10" for a ratio figure, so a percent always shows what it is a percent of. */
export function figureParts(f: Pick<GroupFigure, "numerator" | "denominator">): string | null {
  return f.numerator !== undefined && f.denominator !== undefined
    ? `${f.numerator.toLocaleString("en-US")}/${f.denominator.toLocaleString("en-US")}`
    : null;
}

export function acrossLabel(companyCount: number): string {
  return `across ${companyCount} ${companyCount === 1 ? "company" : "companies"}`;
}

export type CardBody =
  | { kind: "off"; text: string }
  | { kind: "figures"; rows: { key: string; label: string; value: string; parts: string | null }[] };

/** What one company card shows. `figures: null` is the module-off text; an empty list is an empty
 *  card, not a row of zeros. */
export function cardBody(card: GroupCompanyCard): CardBody {
  if (card.figures === null) return { kind: "off", text: MODULE_OFF_TEXT };
  return {
    kind: "figures",
    rows: card.figures.map((f) => ({ key: f.metricKey, label: f.label, value: formatFigureValue(f.unit, f.value), parts: figureParts(f) })),
  };
}

/** The sums that may be shown. The server already adds only additive figures; this is the second
 *  lock: a sum is dropped when any card's figure of that metric is not additive or is ratio-shaped,
 *  so a ratio can never reach the page as a "sum". */
export function displayableSums(report: Pick<GroupReport, "companies" | "sumOfCompanies">): GroupSum[] {
  const unsafe = new Set<string>();
  for (const card of report.companies) {
    for (const f of card.figures ?? []) {
      if (!f.additive || isRatioFigure(f)) unsafe.add(f.metricKey);
    }
  }
  return report.sumOfCompanies.filter((s) => s.unit !== "percent" && !unsafe.has(s.metricKey));
}

export interface SumRow { key: string; label: string; value: string; across: string }

export function sumRows(report: Pick<GroupReport, "companies" | "sumOfCompanies">): SumRow[] {
  return displayableSums(report).map((s) => ({ key: s.metricKey, label: s.label, value: formatFigureValue(s.unit, s.value), across: acrossLabel(s.companyCount) }));
}

/** "needs F9 eliminations" -> "Consolidated figures need F9 eliminations". Any other reason is shown verbatim. */
export function consolidatedNote(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (!r) return "Consolidated figures are not available yet";
  return /^needs /i.test(r) ? `Consolidated figures need ${r.replace(/^needs /i, "")}` : `Consolidated figures are not available: ${r}`;
}
