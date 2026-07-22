// Automation-console module contract (WSA-2). This module surfaces the n8n workflow VIEWER +
// systems consoles served by AdminSystemsController.
//
// DELIBERATE DEVIATION: AdminSystemsController is mounted at /api/admin/* and is PLATFORM-ADMIN /
// GLOBAL scoped (platform_admin/group_executive, plus IT staff for the workflow viewer) — it has
// NO :tenantId route param. The per-tenant ModuleEnabledGuard resolves its decision from
// req.params.tenantId, so it cannot (and should not) gate a global admin console. This contract is
// therefore registered for CATALOG / nav / MCP tool-def aggregation only; the console keeps its
// existing in-code platform-admin authorization. Per-tenant enablement of "automation-console" is
// still carried in companies.enabled_modules (so the module catalog + nav reflect it), but it does
// not 404 the admin routes. See WSA-2 report / follow-ups.
import type { ModuleContract } from "../contract";

export const automationConsoleModule: ModuleContract = {
  key: "automation-console",
  migrations: [],
  permissions: [
    { key: "automation:workflow:read", description: "View n8n workflows (read-only canvas)" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "automation.listWorkflows",
      description: "List n8n workflows via the platform automation console (platform-admin/IT)",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/admin/automation/workflows",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Automation", path: "/systems/automation" }],
  // routes: served by AdminSystemsController (platform-admin scoped; NOT per-tenant gated).
};
