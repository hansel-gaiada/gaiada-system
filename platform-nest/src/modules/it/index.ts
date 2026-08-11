// IT department module contract (WSA-2). Routes live in ItController (mounted at
// /api/:tenantId/it/*, gated by ModuleEnabledGuard("it")); this object carries the
// registry/catalog/MCP metadata. The n8n workflow VIEWER lives in AdminSystemsController
// (platform-admin scoped) — see the automation-console module.
import type { ModuleContract } from "../contract";

export const itModule: ModuleContract = {
  key: "it",
  migrations: ["0019_it_devices.sql", "0071_it_network_discovery.sql"],
  // IAM-01d migration: `device:read` CLEAN, `device:manage` bundle expands to the fine-grained
  // create/update/delete triad. `discovery:report` was ALIAS-dropped — the push path authorizes on
  // plain it.device.create/update (it.controller.ts:296-326, already covered by the bundle above);
  // "discovery collector" becomes a UI-only grouping (IAM-01b-3), not a distinct catalog permission.
  permissions: [
    { key: "it.device.read", description: "View IT devices" },
    { key: "it.device.create", description: "Register IT devices" },
    { key: "it.device.update", description: "Edit devices, ingest heartbeats" },
    { key: "it.device.delete", description: "Delete IT device-registry entries" },
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
