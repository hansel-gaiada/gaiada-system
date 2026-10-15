// DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.6): the functional departments' and the GM's module KPI readers. Each reader
// registers here under the `readerId` its catalogue entry names; dept-kpi-readers.ts merges this record into MODULE_KPI_READERS.
//
// A reader over a module's tables is wrapped in `gated(module, reader)` (../gated): a company without the module reads `null`.
// Readers over core tables (invoice payments) are not gated.
import { gated } from "../gated";
import type { ModuleKpiReader } from "../types";
import { closeOnTime, overdueReceivablesShare } from "./finance";
import { gmMargin } from "./gm";
import { timeToHire } from "./hr-hiring";
import { leaveDecided2d } from "./hr-leave";
import { mandatoryLearning } from "./hr-learning";
import { payrollOnTime } from "./hr-payroll";
import { itLeaverAccessClosed } from "./it-access";
import { itDevicesAlerting, itUptime } from "./it-devices";
import { paymentsConfirmed1d } from "./payments-confirmed";

export const FUNCTIONAL_READERS: Record<string, ModuleKpiReader> = {
  // GM
  "gm.margin": gated("finance", gmMargin),
  // HR (f6 reads the LMS module's tables, so it is gated on `lms`; its walls also open `hr`)
  "hr.leave_decided_2d": gated("hr", leaveDecided2d),
  "hr.payroll_on_time": gated("hr", payrollOnTime),
  "hr.time_to_hire": gated("hr", timeToHire),
  "hr.mandatory_learning": gated("lms", mandatoryLearning),
  // Finance
  "finance.close_on_time": gated("finance", closeOnTime),
  "finance.overdue_receivables_share": gated("finance", overdueReceivablesShare),
  "finance.payments_confirmed_1d": paymentsConfirmed1d,
  // IT (f10 and f12 read the IT tables, tenant wall only; f11 reads HR's separations, so it is gated on `hr`)
  "it.uptime": gated("it", itUptime),
  "it.leaver_access_closed": gated("hr", itLeaverAccessClosed),
  "it.devices_alerting": gated("it", itDevicesAlerting),
};
