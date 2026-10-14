// DW-6n (docs/FRONTEND-BFF-CONTRACT.md §40.5): the delivery departments' module KPI readers. Each reader registers here under
// the `readerId` its catalogue entry (dept-kpis.ts) names; dept-kpi-readers.ts merges this record into MODULE_KPI_READERS.
import type { ModuleKpiReader } from "../types";

export const DELIVERY_READERS: Record<string, ModuleKpiReader> = {};
