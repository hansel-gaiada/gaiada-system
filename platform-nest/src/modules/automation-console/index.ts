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
  // IAM-01d: `automation:workflow:read` is a TRUE ORPHAN (docs/superpowers/plans/
  // 2026-08-10-permission-catalog.md §7) — one of the 2 declared keys with NO Cerbos enforcement
  // anywhere. This file's own header above already documents why: AdminSystemsController is
  // global/platform-admin-scoped in code (isElevated()-style check, plus IT staff for the workflow
  // viewer), not Cerbos-authorized, and has no :tenantId route param for a Cerbos principal to
  // resolve against. Declaring it here would misrepresent an in-code admin check as a role-
  // grantable Cerbos permission, and IAM-01d's fail-closed validation would refuse to boot on it
  // (one of the 7 boot-blockers named in the IAM-01c/01d ticket — 5 assistant relationship keys +
  // this + search:content:publish). REMOVED rather than catalogued: if the n8n viewer should ever
  // become role-grantable, the correct fix is to mint a real `automation_workflow` Cerbos kind
  // first (additive, Phase 2+) and declare the resulting catalog key here — not to invent a
  // catalog entry with no enforcement behind it.
  permissions: [],
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
