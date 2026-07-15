// Authorization policy (WS2 §5): deny-by-default. Tool visibility is filtered per
// principal (you can't call what you can't see — and calls are checked again anyway).
// When Cerbos is configured, the versioned `mcp_tool` policy is authoritative (see the async
// visibleToolsFor/authorizeCall below); this in-code engine remains the fail-closed fallback
// and the source of the human-readable deny/suspend reasons (WS4 §3 depends on them).
import type { Principal, Assurance } from "./principal";
import { allTools, getTool, type HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";
import { cerbosEnabled, cerbosAllowedTools, cerbosAllowsTool } from "./cerbos";

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

// ---- Cerbos-authoritative variants (used by the MCP server). When CERBOS_URL is unset they are
// exactly the in-code decisions; when set, Cerbos decides allow/deny and the in-code engine still
// supplies the deny/suspend reason. Any Cerbos transport error falls back to the (deny-by-default)
// in-code engine — never fail open.

/** Tools this principal may see/use, Cerbos-authoritative when configured. */
export async function visibleToolsFor(principal: Principal): Promise<HubTool[]> {
  const inCode = visibleTools(principal);
  if (!cerbosEnabled()) return inCode;
  try {
    const allowed = await cerbosAllowedTools(principal, allTools());
    return allTools().filter((t) => allowed.has(t.name));
  } catch (err) {
    console.warn(`[policy] cerbos visibility check failed (${(err as Error).message}) — using in-code policy`);
    return inCode;
  }
}

/** Per-call decision, Cerbos-authoritative when configured; in-code reason preserved. */
export async function authorizeCall(principal: Principal, toolName: string): Promise<Decision> {
  const inCode = authorize(principal, toolName);
  if (!cerbosEnabled()) return inCode;
  const tool = getTool(toolName);
  if (!tool) return inCode; // unknown tool — in-code already denies with the right message
  try {
    const allow = await cerbosAllowsTool(principal, tool);
    if (allow) return { allow: true, tool };
    // Cerbos denied. If in-code also denied, keep its rich reason (stepup / not-scoped / suspend);
    // otherwise (a policy drift) return a generic denial — fail closed.
    return inCode.allow ? { allow: false, reason: `denied by policy: ${toolName}` } : inCode;
  } catch (err) {
    console.warn(`[policy] cerbos call check failed (${(err as Error).message}) — using in-code policy`);
    return inCode;
  }
}
