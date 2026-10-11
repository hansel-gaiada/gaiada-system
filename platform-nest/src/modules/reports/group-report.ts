// PV1-06a — the group report (PV-D19): one card per company in a root company tree, plus a
// "Sum of companies" over the figures that can honestly be added. The HTTP shell and both authz
// checks live in group-report.controller.ts; this file owns the two reads (is it a root, which
// companies hang off it) and the pure assembly, so the summing rule is unit-testable without a DB.
//
// THE FIGURES ARE THE COMPANY REPORT'S OWN. Each card is built from the company-grain
// `ReportDocument` that `GET /api/:t/reports/document?grain=company` returns for that company
// (the controller fetches it through `fetchReportDocumentForRead`, the same sealed-else-live path).
// Nothing here recomputes a metric, so a card can never disagree with the company's own report.
//
// THE SUMMING RULE (the reason this file exists, and what group-report.test.ts pins):
//   - A figure is added across companies only when it counts rows that each belong to exactly ONE
//     company: the registry's `additive` range class (task counts, estimate/logged minutes,
//     backlog delta), plus the point-in-time overdue count (#20 — summing it over DAYS is wrong,
//     summing it over companies at the same instant is not).
//   - Ratios (`rangeClass: "ratio"` — on-time rate, utilization, average WIP, …) are NEVER added or
//     averaged. A pooled ratio is a weighted average by another name, and the owner ruled it out.
//   - Distinct unions (#22 source diversity, `distinctOver`) are never added: two companies that
//     both use `pm` have one source between them, not two.
//   - Money is summed per currency and never across currencies. The company report carries NO money
//     figure today (`isMonetary` is false for every report metric — payroll is a non-goal of the
//     reports module), so no money row appears in the sums yet. When a money figure joins the
//     company report it needs a currency on the figure and a currency in the sum key; do not add it
//     to the plain sum.
//   - `consolidated` stays null: a consolidated group figure needs intercompany eliminations (F9).
import { withGlobal } from "../../db";
import { isUuidShaped } from "../../core/dept-resolution";
import { getReportMetric } from "./metrics";
import type { ReportDocument, ReportKpi, ReportPeriodKind, ReportUnit } from "./report-document";

/** One headline figure on a company card — a trimmed `ReportKpi`. */
export interface GroupFigure {
  metricKey: string;
  label: string;
  unit: ReportUnit;
  value: number;
  numerator?: number;
  denominator?: number;
  /** True when this figure feeds `sumOfCompanies` (see the summing rule above). */
  additive: boolean;
}

export interface GroupCompanyCard {
  companyId: string;
  name: string;
  vertical: string;
  /** null when the company has no Company Report to read (the `reports` module is off for it).
   *  Never zeros: zeros would claim a company did nothing. */
  figures: GroupFigure[] | null;
  figuresUnavailable?: "reports_module_not_enabled";
}

export interface GroupSum {
  metricKey: string;
  label: string;
  unit: ReportUnit;
  value: number;
  /** How many cards contributed. Less than `companies.length` when a card has no figures. */
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
  consolidatedReason: "needs F9 eliminations";
}

export interface GroupCompany {
  id: string;
  name: string;
  vertical: string;
}

/** True only for a live company that is its own root (`root_company_id = id`, trigger-maintained by
 *  MON-00a). A non-uuid id is "not a root", never a 500 from the uuid cast. */
export async function isRootCompany(companyId: string): Promise<boolean> {
  if (!isUuidShaped(companyId)) return false;
  const { rows } = await withGlobal((c) =>
    c.query(`SELECT 1 FROM companies WHERE id = $1 AND root_company_id = id AND deleted_at IS NULL`, [companyId]),
  );
  return rows.length > 0;
}

/** Every live company in the root's tree, the root itself first, then by name. `companies` has no
 *  RLS (it is a global table), hence `withGlobal`. */
export async function listGroupCompanies(rootId: string): Promise<GroupCompany[]> {
  const { rows } = await withGlobal((c) =>
    c.query<GroupCompany>(
      `SELECT id, name, vertical FROM companies
        WHERE root_company_id = $1 AND deleted_at IS NULL
        ORDER BY (id = $1) DESC, name, id`,
      [rootId],
    ),
  );
  return rows;
}

/** The summing rule, as one predicate. Keyed off the metric REGISTRY, not the KPI's shape alone, so
 *  a ratio whose denominator happens to be absent is still never added. An unknown metric key is
 *  not additive (fail closed: an unclassified number is not summed). */
export function isAdditiveAcrossCompanies(kpi: ReportKpi): boolean {
  if (kpi.distinctOver) return false;
  let rangeClass: string;
  try {
    rangeClass = getReportMetric(kpi.metricKey).rangeClass;
  } catch {
    return false;
  }
  if (rangeClass === "ratio") return false;
  if (rangeClass === "additive") return true;
  // non_additive: only the point-in-time count (#20) adds across companies.
  return kpi.pointInTime === true;
}

export function toGroupFigures(doc: ReportDocument): GroupFigure[] {
  return doc.kpis.map((k) => {
    const f: GroupFigure = { metricKey: k.metricKey, label: k.label, unit: k.unit, value: k.value, additive: isAdditiveAcrossCompanies(k) };
    if (k.numerator !== undefined) f.numerator = k.numerator;
    if (k.denominator !== undefined) f.denominator = k.denominator;
    return f;
  });
}

/** Sum of companies over the additive figures only, in first-seen order. */
export function sumOfCompanies(cards: GroupCompanyCard[]): GroupSum[] {
  const sums = new Map<string, GroupSum>();
  for (const card of cards) {
    for (const f of card.figures ?? []) {
      if (!f.additive) continue;
      const cur = sums.get(f.metricKey);
      if (cur) {
        cur.value += f.value;
        cur.companyCount += 1;
      } else {
        sums.set(f.metricKey, { metricKey: f.metricKey, label: f.label, unit: f.unit, value: f.value, companyCount: 1 });
      }
    }
  }
  return [...sums.values()];
}

export function assembleGroupReport(input: {
  rootCompanyId: string;
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
  companies: Array<{ company: GroupCompany; document: ReportDocument | null }>;
}): GroupReport {
  const cards: GroupCompanyCard[] = input.companies.map(({ company, document }) =>
    document
      ? { companyId: company.id, name: company.name, vertical: company.vertical, figures: toGroupFigures(document) }
      : {
          companyId: company.id,
          name: company.name,
          vertical: company.vertical,
          figures: null,
          figuresUnavailable: "reports_module_not_enabled",
        },
  );
  return {
    rootCompanyId: input.rootCompanyId,
    periodKind: input.periodKind,
    start: input.start,
    end: input.end,
    companies: cards,
    sumOfCompanies: sumOfCompanies(cards),
    consolidated: null,
    consolidatedReason: "needs F9 eliminations",
  };
}
