// Cerbos decision client for the hub (WS2 §5). The versioned `mcp_tool` policy is authoritative
// for tool visibility + per-call authorization when CERBOS_URL is set; the in-code policy module
// (policy.ts) stays as the fail-closed fallback and the human-readable reason source. A single
// CheckResources call authorizes MANY tools at once (used for tool-list visibility) so the list
// path stays O(1) network hops regardless of tool count.
import { config } from "./config";
import type { Principal } from "./principal";
import type { HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";
import { grantAuthorizesTool, type VerifiedExecutionGrant } from "./approval-grant";

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

/**
 * D14-13 — the `approvalId` resource attribute.
 *
 * The `mcp_tool` policy's impact conjunct lifts the D14 write suspension for a call that carries a
 * verified execution grant (see the header block in
 * `platform-nest/cerbos/policies/resource_mcp_tool.yaml`). The attribute below is the ONLY channel
 * for that, and it is sourced EXCLUSIVELY from `VerifiedExecutionGrant` — a branded type only
 * `verifyExecutionGrant()` can mint (HMAC + canonical args digest + ≤120s expiry + the platform-side
 * single-use claim). It is never read from caller args, a caller header, or any unverified value, so
 * a caller cannot inject it: `hub.ts` hands this layer the verified object or nothing at all.
 *
 * Two further narrowings, both deliberate:
 *   - the key is OMITTED (not set to "" or null) when there is no grant, so every pre-existing
 *     request shape reaches Cerbos byte-identical to before this ticket;
 *   - `grantAuthorizesTool` re-checks the grant's own `toolName` against THIS resource, so a grant
 *     for tool X can never decorate tool Y — which matters for the batched visibility check, where
 *     one request carries many resources.
 */
function toolResource(t: HubTool, grant?: VerifiedExecutionGrant) {
  const granted = grantAuthorizesTool(grant, t.name) ? grant!.approvalId : undefined;
  return {
    kind: "mcp_tool",
    id: t.name,
    attr: {
      name: t.name,
      minAssurance: t.minAssurance,
      write: !!t.write,
      // Empty string for an unclassified write — the policy treats only "low" as auto-allowed.
      impact: t.impact ?? "",
      ...(granted ? { approvalId: granted } : {}),
    },
  };
}

/** Authorize a batch of tools for `call`; returns the set of allowed tool names. Throws on a
 *  transport/Cerbos error so callers fail closed.
 *
 *  `grant` (D14-13) is optional and only ever passed by the single-call path — the tool-LIST path
 *  never has a grant, so visibility is computed exactly as before. */
export async function cerbosAllowedTools(
  principal: Principal,
  tools: HubTool[],
  grant?: VerifiedExecutionGrant,
): Promise<Set<string>> {
  if (tools.length === 0) return new Set();
  const res = await fetch(`${config.cerbosUrl}/api/check/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "hub",
      principal: principalPayload(principal),
      resources: tools.map((t) => ({ actions: ["call"], resource: toolResource(t, grant) })),
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

/** Authorize a single tool call. Throws on a Cerbos error (caller fail-closes).
 *  `grant`: the VERIFIED execution grant for this exact call, if any (D14-13). */
export async function cerbosAllowsTool(
  principal: Principal,
  tool: HubTool,
  grant?: VerifiedExecutionGrant,
): Promise<boolean> {
  const allowed = await cerbosAllowedTools(principal, [tool], grant);
  return allowed.has(tool.name);
}
