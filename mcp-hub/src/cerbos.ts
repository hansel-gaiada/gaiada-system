// Cerbos decision client for the hub (WS2 §5). The versioned `mcp_tool` policy is authoritative
// for tool visibility + per-call authorization when CERBOS_URL is set; the in-code policy module
// (policy.ts) stays as the fail-closed fallback and the human-readable reason source. A single
// CheckResources call authorizes MANY tools at once (used for tool-list visibility) so the list
// path stays O(1) network hops regardless of tool count.
import { config } from "./config";
import type { Principal } from "./principal";
import type { HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";

export function cerbosEnabled(): boolean {
  return !!config.cerbosUrl;
}

function principalPayload(p: Principal) {
  const automation = isAutomation(p.provider);
  return {
    id: p.externalId || "anonymous",
    roles: ["hub_caller"],
    attr: {
      assurance: p.assurance,
      provider: p.provider,
      isAutomation: automation,
      automationScope: automation ? [...workflowScope(p.externalId)] : [],
    },
  };
}

function toolResource(t: HubTool) {
  return {
    kind: "mcp_tool",
    id: t.name,
    attr: {
      name: t.name,
      minAssurance: t.minAssurance,
      write: !!t.write,
      // Empty string for an unclassified write — the policy treats only "low" as auto-allowed.
      impact: t.impact ?? "",
    },
  };
}

/** Authorize a batch of tools for `call`; returns the set of allowed tool names. Throws on a
 *  transport/Cerbos error so callers fail closed. */
export async function cerbosAllowedTools(principal: Principal, tools: HubTool[]): Promise<Set<string>> {
  if (tools.length === 0) return new Set();
  const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "hub",
      principal: principalPayload(principal),
      resources: tools.map((t) => ({ actions: ["call"], resource: toolResource(t) })),
    }),
  });
  if (!res.ok) throw new Error(`cerbos ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ resource?: { id?: string }; actions?: Record<string, string> }> };
  const allowed = new Set<string>();
  for (const r of data.results ?? []) {
    if (r.actions?.call === "EFFECT_ALLOW" && r.resource?.id) allowed.add(r.resource.id);
  }
  return allowed;
}

/** Authorize a single tool call. Throws on a Cerbos error (caller fail-closes). */
export async function cerbosAllowsTool(principal: Principal, tool: HubTool): Promise<boolean> {
  const allowed = await cerbosAllowedTools(principal, [tool]);
  return allowed.has(tool.name);
}
