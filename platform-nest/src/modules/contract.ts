// ModuleContract (WS1 sub-spec §1.2, verbatim shape). Compile-time modules + runtime
// per-tenant enable flag. STRICT dependency rule (§1.3): modules import core; core
// NEVER imports from src/modules/<key>/ (registry discovers via explicit registration
// in server bootstrap, which lives outside core).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { OutboxEvent } from "../events/types";

export interface PermissionDef {
  key: string; // e.g. 'agency:campaign:approve'
  description: string;
}

export interface McpToolDef {
  name: string; // e.g. 'agency.pendingApprovals'
  description: string;
  minAssurance: "low" | "verified";
  inputSchema: Record<string, unknown>;
  /** HTTP mapping so the MCP hub can front this tool generically (WS2 §6 aggregation).
   *  `pathTemplate` uses :param tokens filled from the tool's args (e.g.
   *  "/api/:tenantId/modules/agency/campaigns"); remaining args become the request body for
   *  POST/PATCH. Omit method/pathTemplate for a purely-informational def. */
  method?: "GET" | "POST" | "PATCH";
  pathTemplate?: string;
  /** Mutating tool (drives the hub's D14 automation write gate). */
  write?: boolean;
  impact?: "low" | "medium" | "high";
}

export interface MetricDef {
  metricKey: string; // canonical, module-prefixed: 'agency.campaigns.active'
  description: string;
  unit: "count" | "ratio" | "minutes" | "money_minor";
  isMonetary: boolean;
  aggregationRule: "sum" | "ratio_of_sums" | "max" | "last";
}

export interface RollupRow {
  metricKey: string;
  numerator: number;
  denominator?: number;
  currency?: string;
  dimensions?: Record<string, unknown>;
}

export interface RollupProvider {
  metrics: MetricDef[]; // registered into metric_definitions (D12 governance)
  /** Compute this tenant's rows for a period from LOCAL data (D12). Must be pure-read. */
  compute: (client: PoolClient, tenantId: string, period: string) => Promise<RollupRow[]>;
}

export interface UiManifestEntry {
  label: string;
  path: string;
}

export interface ModuleContract {
  key: string; // 'agency', 'resort', ...
  /** Migration files this module owns (must exist in migrations/; applied globally). */
  migrations: string[];
  /** Fastify-era route registrar. In the NestJS port each vertical is a NestJS module +
   *  controller instead, so this is OPTIONAL (kept for the registry/rollup metadata shape). */
  routes?: (app: FastifyInstance) => void;
  permissions: PermissionDef[];
  customFieldTargets: string[];
  mcpTools: McpToolDef[];
  rollupProviders: RollupProvider[];
  uiManifest: UiManifestEntry[];
  /** Event backbone (WS1 sub-spec): handlers for domain events this module reacts to,
   *  keyed by event_type. Dispatched by EventConsumerService only if the module is
   *  enabled for the event's tenant. */
  eventHandlers?: { [eventType: string]: (event: OutboxEvent) => Promise<void> };
}
