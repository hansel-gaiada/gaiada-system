import "server-only";
// Admin/systems data layer — single source of truth for every admin-surface
// path/shape the UI consumes. The backend admin API does not exist yet; every
// reader here DEGRADES gracefully (null/[] on 404/403) so pages can ship ahead
// of the backend and show a "not connected yet" state instead of crashing.
//
// Contract (see docs/superpowers/plans/2026-07-05-erp-ui-plan-3-systems-consoles.md,
// "Admin-API contract"): the platform proxies each service's admin surface at
// /api/admin/:system/* for system in SystemKey. Some surfaces expose extra
// reads (egress audit, hub tools, agent goals, knowledge sources) — all
// optional and graceful.
import { platformFetch, PlatformError } from "./platform";

export type SystemKey = "bot" | "gateway" | "hub" | "agents" | "knowledge" | "automation";

export interface SystemStatus {
  ok: boolean;
  version?: string;
  uptimeSec?: number;
  counters?: Record<string, number | string>;
  detail?: Record<string, unknown>;
}

export interface ConfigField {
  key: string;
  label: string;
  value: unknown;
  kind: "text" | "number" | "boolean" | "select" | "secretPresence";
  options?: string[];
  editable: boolean;
}

export interface AuditRow {
  time: string;
  provider?: string;
  decision?: string;
  detail?: string;
}

export interface HubTool {
  name: string;
  description: string;
  minAssurance: string;
}

export interface AgentGoal {
  id: string;
  goal: string;
  status: string;
  budgetSpent?: number;
  budgetTotal?: number;
  fanOut?: number;
}

export interface KnowledgeSource {
  id: string;
  source: string;
  provenance?: string;
  status: string;
}

// Absorbs both 404 (endpoint not found) and 403 (feature not enabled) so
// callers get a graceful fallback either way — mirrors lib/entities.ts.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// ---- Status/config (per system) ----
export const getSystemStatus = (userId: string, system: SystemKey) =>
  skipUnavailable(platformFetch<SystemStatus>(`/api/admin/${system}/status`, userId), null as SystemStatus | null);

export async function getSystemConfig(userId: string, system: SystemKey): Promise<ConfigField[]> {
  const res = await skipUnavailable(
    platformFetch<{ fields: ConfigField[] }>(`/api/admin/${system}/config`, userId),
    null as { fields: ConfigField[] } | null,
  );
  return res?.fields ?? [];
}

// ---- Extra reads (optional, per surface) ----
export const getEgressAudit = (userId: string) =>
  skipUnavailable(platformFetch<AuditRow[]>(`/api/admin/gateway/egress-audit`, userId), [] as AuditRow[]);

export const getHubTools = (userId: string) =>
  skipUnavailable(platformFetch<HubTool[]>(`/api/admin/hub/tools`, userId), [] as HubTool[]);

export const getAgentGoals = (userId: string, tenantId: string) =>
  skipUnavailable(platformFetch<AgentGoal[]>(`/api/${tenantId}/agents/goals`, userId), [] as AgentGoal[]);

export const getKnowledgeSources = (userId: string, tenantId: string) =>
  skipUnavailable(platformFetch<KnowledgeSource[]>(`/api/${tenantId}/knowledge/sources`, userId), [] as KnowledgeSource[]);

// Pure. 0 -> "0m"; 61 -> "1m"; 3661 -> "1h 1m"; 90061 -> "1d 1h 1m".
// Drops zero leading units (days/hours); always shows minutes if nothing else.
export function formatUptime(sec: number): string {
  const totalMinutes = Math.floor(sec / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
