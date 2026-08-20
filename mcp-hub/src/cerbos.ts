// Cerbos decision client for the hub (WS2 §5). The versioned `mcp_tool` policy is authoritative
// for tool visibility + per-call authorization when CERBOS_URL is set; the in-code policy module
// (policy.ts) stays as the fail-closed fallback and the human-readable reason source. A single
// CheckResources call authorizes MANY tools at once (used for tool-list visibility) so the list
// path stays O(1) network hops regardless of tool count.
import { config } from "./config";
import type { Principal } from "./principal";
import type { HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";
import { isUnattended } from "./principal";
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
      // ── 2026-08-20: the attribute the impact gate actually needs ─────────────────────────────────
      // `isAutomation` is `provider === "n8n"`, and the policy's impact conjunct was keyed on it. An
      // agent-driven call arrives under the requesting HUMAN's envelope (runAgent sends it verbatim so
      // an agent can never out-rank the person it serves), so `isAutomation` was false and the
      // medium/high suspend never fired — in the policy as well as in code. Cerbos is authoritative
      // whenever CERBOS_URL is set, so fixing only the in-code branch would have left the live
      // deployment wide open.
      //
      // `isUnattended` = n8n OR agent-driven. `isAutomation` is KEPT because the workflow-scope
      // conjunct is genuinely n8n-specific and must not start applying to agents, which have no
      // `wf:*` id and would therefore fail an allow-list lookup that was never about them.
      isUnattended: isUnattended(p),
      // The co-author, for policy authors who want to reason about a specific agent later. Empty
      // string rather than absent so a CEL expression can compare it without a `has()` guard.
      agent: p.agent ?? "",
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

/**
 * Cerbos refuses a `CheckResources` request carrying more resources than its own
 * `server.requestLimits.maxActionsPerResource`/batch cap — 50 by default, and this deployment runs the
 * default. The cap is SERVER-side, so the client must chunk.
 *
 * ⚠ THIS IS NOT A TUNING KNOB, IT IS A LIVE DEFECT FIX (2026-08-19). Once the hub's tool count passed
 * 50, EVERY visibility check began failing with `InvalidArgument: number of resources in batch (128)
 * exceeds configured limit (50)`, and `visibleToolsFor` caught it and fell back to the in-code engine.
 * Not fail-open — the in-code engine is deny-by-default and mirrors the assurance and
 * automation-scope rules — but Cerbos had silently stopped being AUTHORITATIVE for the tool list,
 * which is the one thing `resource_mcp_tool.yaml` exists to be. It was invisible because the fallback
 * logs a warning and returns a plausible answer; it was found by reading cerbos's own logs on the box,
 * not by any test or alert.
 *
 * 40 rather than 50: headroom, so a deployment that lowers the limit slightly does not silently
 * reintroduce the same failure. Chunking client-side rather than raising the server limit is
 * deliberate — the limit is a defence against unbounded requests, and the hub's tool count only grows.
 */
export const CERBOS_RESOURCE_BATCH_MAX = 40;

/** Authorize a batch of tools for `call`; returns the set of allowed tool names. Throws on a
 *  transport/Cerbos error so callers fail closed.
 *
 *  `grant` (D14-13) is optional and only ever passed by the single-call path — the tool-LIST path
 *  never has a grant, so visibility is computed exactly as before.
 *
 *  Chunked at CERBOS_RESOURCE_BATCH_MAX (see above). Chunks are evaluated CONCURRENTLY and any one
 *  chunk's rejection rejects the whole call, preserving the fail-closed contract: a partial answer
 *  would be indistinguishable from "Cerbos denied those tools", which is exactly the confusion that
 *  let the original defect hide. */
export async function cerbosAllowedTools(
  principal: Principal,
  tools: HubTool[],
  grant?: VerifiedExecutionGrant,
): Promise<Set<string>> {
  if (tools.length === 0) return new Set();

  const chunks: HubTool[][] = [];
  for (let i = 0; i < tools.length; i += CERBOS_RESOURCE_BATCH_MAX) {
    chunks.push(tools.slice(i, i + CERBOS_RESOURCE_BATCH_MAX));
  }

  const sets = await Promise.all(chunks.map((chunk) => checkChunk(principal, chunk, grant)));
  const allowed = new Set<string>();
  for (const s of sets) for (const name of s) allowed.add(name);
  return allowed;
}

async function checkChunk(
  principal: Principal,
  tools: HubTool[],
  grant?: VerifiedExecutionGrant,
): Promise<Set<string>> {
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
