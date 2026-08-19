// MON-10b — the `monitoring` module contract: PLANE B, the tenant's clients' websites and services.
//
// Design: docs/blueprints/monitoring-program.md §3. Contract: docs/FRONTEND-BFF-CONTRACT.md §20.
// Schema: migrations/0116_module_monitoring.sql. IAM seed: 0117_iam_monitoring_permissions.sql.
//
// ── THIS IS NOT PLATFORM OBSERVABILITY ──────────────────────────────────────────────────────────
// Prometheus/Grafana/Loki/Tempo watch OUR infrastructure, are platform-admin only, and live on the
// SumoPod VPS (relocated 2026-08-18). That surface is `/api/admin/observability` and is deliberately
// NOT a module: it is not tenant-scoped and must never be reachable per-tenant. The two planes never
// merge (§8.1) — Gaia Nexus merged them, which is exactly why its dashboard was a hash function.
//
// ── EVERY PERMISSION HERE MUST ALREADY BE CATALOGUED ────────────────────────────────────────────
// `validateModulePermissions()` REFUSES BOOT if any key below is not a `class='grantable'` row in the
// `permissions` catalog. That is why 0117 lands with (not after) this file: the failure mode is the
// platform not starting, not a red test.
import type { ModuleContract } from "../contract";

export const monitoringModule: ModuleContract = {
  key: "monitoring",
  migrations: [
    "0116_module_monitoring.sql",
    "0117_iam_monitoring_permissions.sql",
    "0119_monitoring_heartbeat_touch.sql",
  ],

  // Mirrors 0117 exactly. Staff/manager split lives in the migration's bundles; this list is the
  // module's declared surface, not a grant.
  permissions: [
    { key: "monitoring.monitor.read", description: "View monitors, results, incidents and uptime" },
    { key: "monitoring.monitor.create", description: "Create monitors (authorizes scheduled probing only)" },
    { key: "monitoring.monitor.update", description: "Edit monitors, assertions, interval and severity" },
    { key: "monitoring.monitor.delete", description: "Delete monitors and their history" },
    { key: "monitoring.incident.acknowledge", description: "Acknowledge an open monitoring incident" },
    { key: "monitoring.maintenance.create", description: "Schedule maintenance windows (suppresses alerts and SLA impact)" },
    { key: "monitoring.channel.read", description: "View notification channels and routing rules" },
    { key: "monitoring.channel.manage", description: "Manage and test notification channels and routes" },
    { key: "monitoring.status_page.publish", description: "Publish a client status page (readable WITHOUT authentication)" },
  ],

  customFieldTargets: [],

  // Agentic-native bar: every capability must work identically under a human, under n8n, and under an
  // agent. These are READ-ONLY on purpose for now. An agent may observe and correlate; it may not
  // create a monitor, acknowledge an incident, or publish a status page — those go through ASST-23
  // write proposals and a D14 approval. Two standing rules from the search programme apply verbatim:
  // automation must never trigger a paid or externally-destructive action, and no allow-list may ever
  // include a money-spending tool.
  //
  // Every tool carries a real `pathTemplate`: 14 of 18 `search.*` tools shipped as pathTemplate-less
  // stubs and were silently uncallable by any agent or flow. A registered-but-unwired tool is
  // indistinguishable from an absent one.
  mcpTools: [
    {
      name: "monitoring.listMonitors",
      description: "List the tenant's monitors with current status, uptime and expiry warnings",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/monitoring/monitors",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          clientId: { type: "string" },
          status: { type: "string", enum: ["up", "down", "degraded", "maintenance", "unknown"] },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "monitoring.openIncidents",
      description: "List open monitoring incidents, worst-severity first — the actionable view for triage",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/monitoring/incidents",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, limit: { type: "number" } },
        required: ["tenantId"],
      },
    },
    {
      name: "monitoring.monitorDetail",
      description: "One monitor's detail: recent check results, incident history and expiry state",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/monitoring/monitors/:id",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, id: { type: "string" } },
        required: ["tenantId", "id"],
      },
    },
  ],

  // D12 metric governance lives INSIDE a RollupProvider (contract.ts), not at the contract root --
  // metrics and the function that computes them are declared together on purpose, so a metric cannot
  // be registered with nothing able to produce it.
  //
  // That is exactly why there is no provider yet. MON-12 owns the runner that produces check results;
  // declaring `monitoring.uptime.ratio` now would register a metric whose compute returns zero for a
  // period nothing measured -- indistinguishable from a healthy quiet estate, which is the failure
  // this programme exists to prevent. The intended set, to land with MON-12:
  //   monitoring.monitors.active  count  sum
  //   monitoring.incidents.open   count  sum
  //   monitoring.uptime.ratio     ratio  ratio_of_sums  <-- NOT a mean of per-monitor ratios: that
  //     weights an hourly-checked monitor the same as a minutely one, quietly flattering or punishing
  //     a client based on how their checks happen to be configured.
  rollupProviders: [],

  uiManifest: [
    { label: "Monitoring", path: "/monitoring" },
  ],
};
