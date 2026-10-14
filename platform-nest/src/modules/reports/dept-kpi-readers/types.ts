// DW-6n / DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1): the shape of a department KPI's module reader. A reader turns one
// unit's window into a value, or `null` when there is nothing to measure. It is pure over its inputs: it never reads the
// clock, and every "already due" test uses `asOf`, which the engine computes once per evaluation.
import type { ReportPeriodKind } from "../report-document";
import type { KpiValue } from "../dept-kpis";

export interface ReaderCtx {
  tenantId: string;
  /** The department's org-unit node id. The reader's scope is this unit and its subtree (§40.5.2). */
  unitId: string;
  periodKind: ReportPeriodKind;
  /** ISO date, inclusive, in REPORTS_TZ. */
  start: string;
  /** ISO date, inclusive, in REPORTS_TZ. */
  end: string;
  /** ISO date in REPORTS_TZ: the earlier of `end` and today. A due date on or before it is "already due". */
  asOf: string;
}

export type ModuleKpiReader = (ctx: ReaderCtx) => Promise<KpiValue | null>;
