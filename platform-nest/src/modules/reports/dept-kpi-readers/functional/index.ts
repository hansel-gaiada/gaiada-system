// DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.6): the functional departments' and the GM's module KPI readers. Each reader
// registers here under the `readerId` its catalogue entry names; dept-kpi-readers.ts merges this record into MODULE_KPI_READERS.
import type { ModuleKpiReader } from "../types";

export const FUNCTIONAL_READERS: Record<string, ModuleKpiReader> = {};
