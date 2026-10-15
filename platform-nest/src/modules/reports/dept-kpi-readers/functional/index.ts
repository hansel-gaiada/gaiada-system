// DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.6): the functional departments' and the GM's module KPI readers. Each reader
// registers here under the `readerId` its catalogue entry names; dept-kpi-readers.ts merges this record into MODULE_KPI_READERS.
//
// A reader over a module's tables is wrapped in `gated(module, reader)` (../gated): a company without the module reads `null`.
// Readers over core tables (invoice payments) are not gated.
import { gated } from "../gated";
import type { ModuleKpiReader } from "../types";
import { closeOnTime, overdueReceivablesShare } from "./finance";
import { gmMargin } from "./gm";
import { paymentsConfirmed1d } from "./payments-confirmed";

export const FUNCTIONAL_READERS: Record<string, ModuleKpiReader> = {
  // GM
  "gm.margin": gated("finance", gmMargin),
  // Finance
  "finance.close_on_time": gated("finance", closeOnTime),
  "finance.overdue_receivables_share": gated("finance", overdueReceivablesShare),
  "finance.payments_confirmed_1d": paymentsConfirmed1d,
};
