// Project-management module contract (WSA-2). Routes live in PmController (mounted at
// /api/:tenantId/pm/*, gated by ModuleEnabledGuard("pm")); this object carries the
// registry/catalog/MCP metadata. Rollups for PM tasks are currently emitted by the CORE
// task rollup provider (rollups/engine coreTaskRollups), so this contract adds no rollupProvider.
import type { ModuleContract } from "../contract";

export const pmModule: ModuleContract = {
  key: "pm",
  migrations: ["0018_pm.sql"],
  permissions: [
    { key: "pm:task:read", description: "View project tasks" },
    { key: "pm:task:create", description: "Create project tasks" },
    { key: "pm:task:manage", description: "Assign/manage tasks, milestones and docs" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "pm.listTasks",
      description: "List the tenant's project tasks (Repsona-style rich tasks)",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/pm/tasks",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "pm.runTracker",
      description: "Run the AI Tracker on a task to propose progress/status updates",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/pm/tasks/:taskId/tracker/run",
      write: true,
      impact: "low",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
        required: ["tenantId", "taskId"],
      },
    },
  ],
  rollupProviders: [],
  uiManifest: [
    { label: "Projects", path: "/projects" },
    { label: "Tasks", path: "/tasks" },
  ],
  // routes: served by PmController in the NestJS port.
};
