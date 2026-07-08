// Authorization policy (WS2 §5): deny-by-default. Tool visibility is filtered per
// principal (you can't call what you can't see — and calls are checked again anyway).
// Cerbos replaces this module in the platform phase; the call sites stay identical.
import type { Principal, Assurance } from "./principal";
import { allTools, getTool, type HubTool } from "./registry";

const RANK: Record<Assurance, number> = { anonymous: 0, low: 1, verified: 2 };

export function permits(principal: Principal, tool: HubTool): boolean {
  return RANK[principal.assurance] >= RANK[tool.minAssurance];
}

/** Tools this principal may see/use — advertise nothing it can't call. */
export function visibleTools(principal: Principal): HubTool[] {
  return allTools().filter((t) => permits(principal, t));
}

export type Decision = { allow: true; tool: HubTool } | { allow: false; reason: string };

/** Per-call check (deny-by-default: unknown tool or insufficient assurance → deny). */
export function authorize(principal: Principal, toolName: string): Decision {
  const tool = getTool(toolName);
  if (!tool) return { allow: false, reason: `unknown tool: ${toolName}` };
  if (!permits(principal, tool)) {
    return {
      allow: false,
      reason: `denied: ${toolName} requires ${tool.minAssurance} assurance; caller has ${principal.assurance} (step up on a verified surface)`,
    };
  }
  return { allow: true, tool };
}
