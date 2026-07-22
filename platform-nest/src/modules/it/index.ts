// IT department module contract (WSA-2). Routes live in ItController (mounted at
// /api/:tenantId/it/*, gated by ModuleEnabledGuard("it")); this object carries the
// registry/catalog/MCP metadata. The n8n workflow VIEWER lives in AdminSystemsController
// (platform-admin scoped) — see the automation-console module.
import type { ModuleContract } from "../contract";

export const itModule: ModuleContract = {
  key: "it",
  migrations: ["0019_it_devices.sql"],
  permissions: [
    { key: "it:device:read", description: "View IT devices" },
    { key: "it:device:manage", description: "Register/edit devices, ingest heartbeats" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "it.listDevices",
      description: "List the tenant's registered IT devices with status",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/it/devices",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "IT", path: "/it" }],
  // routes: served by ItController in the NestJS port.
};
