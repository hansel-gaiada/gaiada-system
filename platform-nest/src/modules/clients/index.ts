// Clients (CRM) module contract (WSA-2). The `clients` RESOURCE routes live in ClientsController
// (mounted at /api/:tenantId/clients*, gated by ModuleEnabledGuard("clients")).
// NOTE: `deliverables` and `time_entries` deliberately REMAIN core (ClientWorkController) — they
// are the shared work substrate every vertical (PM, agency, billing) reads/writes, so they are
// NOT gated behind this module. Only the client-relationship resource is module-gated.
import type { ModuleContract } from "../contract";

export const clientsModule: ModuleContract = {
  key: "clients",
  migrations: ["0001_core.sql"],
  // IAM-01d migration: all 4 CLEAN but RE-DOMAINED — `client` is a 0001 core-schema kind shared by
  // files/meetings/pipeline/portal/contracts/search (catalog Judgement J1), so the grantable
  // permission is `core.client.*`, not `clients.client.*`, even though this module owns the CRUD
  // routes for it.
  permissions: [
    { key: "core.client.read", description: "View clients" },
    { key: "core.client.create", description: "Create clients" },
    { key: "core.client.update", description: "Edit clients" },
    { key: "core.client.delete", description: "Delete clients" },
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
