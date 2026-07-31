// Reports module contract (TR-08). ROUTES (facts recompute) live in ReportsController and are
// registered directly on AppModule (§6.2: `/api/:t/reports/*`, not `/api/:t/modules/reports/*` —
// see reports.controller.ts's header); this object carries the registry/rollup metadata the
// engine + registry + (future) hub tool-def aggregation consume, same split as hrModule/index.ts.
//
// `rollupProviders: [reportRollups]` is what makes `rollups/engine.ts`'s per-module invocation loop
// (`recomputeRollups`) find and run TR-08's provider under the tenant's `reports` module scope —
// registering it here, rather than building a parallel recompute path, is the ticket's explicit
// instruction ("Register through this; do not build a parallel path").
import type { ModuleContract } from "../contract";
import { reportRollups } from "./report-rollups";

export const reportsModule: ModuleContract = {
  key: "reports",
  migrations: ["0056_module_reports_core.sql", "0057_report_metric_seeds.sql"],
  permissions: [
    { key: "reports:metrics:read", description: "View the tenant's report/appraisal rollup metrics" },
  ],
  customFieldTargets: [],
  mcpTools: [],
  rollupProviders: [reportRollups],
  uiManifest: [{ label: "Reports", path: "/reports" }],
  // routes: ReportsController (registered on AppModule directly — see its own header comment).
};
