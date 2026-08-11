// Knowledge (D9 RAG) module contract (WSA-2). The tenant-scoped knowledge routes
// (/api/:tenantId/knowledge/sources[+/:id/review]) live in IntelligenceController and are gated
// per-method by ModuleEnabledGuard("knowledge"). The platform proxies the D9 knowledge service;
// there is no platform-owned knowledge table, so migrations is empty.
import type { ModuleContract } from "../contract";

export const knowledgeModule: ModuleContract = {
  key: "knowledge",
  migrations: [],
  // IAM-01d migration: `source:read` CLEAN. `source:review` was ALIAS (approve/reject quarantine
  // authorizes Cerbos `update`, not a distinct `review` action) — adopted the real spelling
  // (knowledge.source.update) rather than dropped, since the module's review UI needs a named
  // permission to gate on.
  permissions: [
    { key: "knowledge.source.read", description: "View knowledge sources" },
    { key: "knowledge.source.update", description: "Approve/reject quarantined knowledge sources" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "knowledge.listSources",
      description: "List the tenant's knowledge sources (D9)",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/knowledge/sources",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [],
  uiManifest: [{ label: "Knowledge", path: "/knowledge" }],
  // routes: served by IntelligenceController (knowledge methods; ModuleEnabledGuard("knowledge")).
};
