// Clients (CRM) module contract (WSA-2). The `clients` RESOURCE routes live in ClientsController
// (mounted at /api/:tenantId/clients*, gated by ModuleEnabledGuard("clients")).
// NOTE: `deliverables` and `time_entries` deliberately REMAIN core (ClientWorkController) — they
// are the shared work substrate every vertical (PM, agency, billing) reads/writes, so they are
// NOT gated behind this module. Only the client-relationship resource is module-gated.
import type { ModuleContract } from "../contract";

export const clientsModule: ModuleContract = {
  key: "clients",
  migrations: ["0001_core.sql"],
  permissions: [
    { key: "clients:client:read", description: "View clients" },
    { key: "clients:client:create", description: "Create clients" },
    { key: "clients:client:update", description: "Edit clients" },
    { key: "clients:client:delete", description: "Delete clients" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "clients.listClients",
      description: "List the tenant's clients",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/clients",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Clients", path: "/clients" }],
  // routes: served by ClientsController (src/modules/clients/clients.controller.ts).
};
