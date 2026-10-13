// Clients (CRM) module contract (WSA-2). The `clients` RESOURCE routes live in ClientsController
// (mounted at /api/:tenantId/clients*, gated by ModuleEnabledGuard("clients")).
// NOTE: `deliverables` and `time_entries` deliberately REMAIN core (ClientWorkController) — they
// are the shared work substrate every vertical (PM, agency, invoices) reads/writes, so they are
// NOT gated behind this module. Only the client-relationship resource is module-gated.
import type { ModuleContract } from "../contract";

export const clientsModule: ModuleContract = {
  key: "clients",
  // Client Centre (CC piece 2): client_centre_profiles is its OWN migration, deliberately not
  // module-walled (client-reachable table — see that migration's own header). Listed here for
  // documentation only; nothing in the registry reads ModuleContract.migrations programmatically.
  migrations: ["0001_core.sql", "202609281655_client_centre_profiles.sql", "202609290551_client_owner.sql"],
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
    {
      name: "clients.getBusinessProfile",
      description:
        "Read one client's Business profile (Client Centre): business type, profile fields, connections, " +
        "business areas and custom connections, plus canEdit. The profile never holds credentials: a connection " +
        "records where its credential lives, and a credential value is refused.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/clients/:clientId/centre",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client." },
        },
        required: ["tenantId", "clientId"],
      },
    },
    {
      name: "clients.updateBusinessProfile",
      description:
        "Edit one client's Business profile, key by key (merge, audited, reversible). Requires client update. " +
        "Unknown keys are refused, and the server's credential-value scanner refuses any secret; the profile never holds credentials. " +
        "Set a value to null to clear it.",
      minAssurance: "low",
      write: true,
      impact: "low",
      method: "PATCH",
      pathTemplate: "/api/:tenantId/clients/:clientId/centre",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client." },
          businessType: { type: "string", description: "The Business type id." },
          profile: {
            type: "object",
            description: "Profile field key to string, or null to clear. Merged key by key.",
            additionalProperties: { type: ["string", "null"] },
          },
          connections: {
            type: "object",
            description: "Connection id to a partial entry ({tool, account, url, owner, creds, method, status, notes}), or null to clear. creds is where a credential lives; never the credential value.",
            additionalProperties: { type: ["object", "null"] },
          },
          areas: {
            type: "object",
            description: "Business area id to true (in scope), false (out of scope), or null (unset).",
            additionalProperties: { type: ["boolean", "null"] },
          },
          customConnections: {
            type: "object",
            description: "Section key to a list of custom connection refs ({id, name}). A custom connection is created here before `connections` can edit it.",
            additionalProperties: { type: "array", items: { type: "object" } },
          },
        },
        required: ["tenantId", "clientId"],
      },
    },
    {
      name: "clients.getBusinessResults",
      description:
        "Read one client's Business results: the service cards composed for this client. " +
        "Only client-visible figures are returned.",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/clients/:clientId/centre/results",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          clientId: { type: "string", description: "The client." },
        },
        required: ["tenantId", "clientId"],
      },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Clients", path: "/clients" }],
  // routes: served by ClientsController (src/modules/clients/clients.controller.ts).
};
