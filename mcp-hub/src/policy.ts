// Authorization policy (WS2 §5): deny-by-default. Tool visibility is filtered per
// principal (you can't call what you can't see — and calls are checked again anyway).
// Cerbos replaces this module in the platform phase; the call sites stay identical.
import type { Principal, Assurance } from "./principal";
import { allTools, getTool, type HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";

const RANK: Record<Assurance, number> = { anonymous: 0, low: 1, verified: 2 };

export function permits(principal: Principal, tool: HubTool): boolean {
  if (RANK[principal.assurance] < RANK[tool.minAssurance]) return false;
  // Automation (n8n) principals are scoped to their workflow's allow-list, not assurance alone.
  if (isAutomation(principal.provider)) {
    return workflowScope(principal.externalId).includes(tool.name);
  }
  return true;
}

/** Tools this principal may see/use — advertise nothing it can't call. */
export function visibleTools(principal: Principal): HubTool[] {
  return allTools().filter((t) => permits(principal, t));
}

export type Decision = { allow: true; tool: HubTool } | { allow: false; reason: string };

/** Per-call check (deny-by-default: unknown tool, insufficient assurance, out-of-scope for an
 *  automation workflow, or a non-low-impact write attempted unattended → deny). */
export function authorize(principal: Principal, toolName: string): Decision {
  const tool = getTool(toolName);
  if (!tool) return { allow: false, reason: `unknown tool: ${toolName}` };
  if (RANK[principal.assurance] < RANK[tool.minAssurance]) {
    return {
      allow: false,
      reason: `denied: ${toolName} requires ${tool.minAssurance} assurance; caller has ${principal.assurance} (step up on a verified surface)`,
    };
  }
  if (isAutomation(principal.provider)) {
    if (!workflowScope(principal.externalId).includes(tool.name)) {
      return { allow: false, reason: `denied: workflow ${principal.externalId} is not scoped for ${toolName}` };
    }
    // Write gate (§3 / D14): unattended automation runs LOW-impact writes only; medium/high and
    // unclassified writes suspend for human approval — the workflow surfaces this as a pending approval.
    if (tool.write && tool.impact !== "low") {
      const tier = tool.impact ?? "unclassified";
      return {
        allow: false,
        reason: `suspend: ${toolName} is a ${tier}-impact write; automation requires human approval (only low-impact writes run unattended)`,
      };
    }
  }
  return { allow: true, tool };
}
