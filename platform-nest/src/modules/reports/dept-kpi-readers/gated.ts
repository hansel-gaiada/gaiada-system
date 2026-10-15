// DW-6n / DW-7 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1 and §40.6.1): the module gate every department KPI reader registry shares.
// A reader over a module's tables runs only when the company has that module, so a company that turned it off reads `null`
// (`no_data`) instead of its old rows: `app_module_allowed()` checks only the scopes a query declares, not whether the company
// has the module. delivery/index.ts re-exports this, so DW-6's registry and its test keep one import path.
import { isModuleEnabled } from "../../registry";
import type { ModuleKpiReader } from "./types";

/** The reader, run only when the company has `module` (own `enabled_modules` or an active service assignment). */
export const gated =
  (module: string, read: ModuleKpiReader): ModuleKpiReader =>
  async (ctx) =>
    (await isModuleEnabled(ctx.tenantId, module)) ? read(ctx) : null;
