// Authorization policy (WS2 §5): deny-by-default. Tool visibility is filtered per
// principal (you can't call what you can't see — and calls are checked again anyway).
// When Cerbos is configured, the versioned `mcp_tool` policy is authoritative (see the async
// visibleToolsFor/authorizeCall below); this in-code engine remains the fail-closed fallback
// and the source of the human-readable deny/suspend reasons (WS4 §3 depends on them).
import type { Principal, Assurance } from "./principal";
import { allTools, getTool, type HubTool } from "./registry";
import { isAutomation, workflowScope } from "./automation-policy";
import { isUnattended } from "./principal";
import { cerbosEnabled, cerbosAllowedTools, cerbosAllowsTool } from "./cerbos";
import { grantAuthorizesTool, type VerifiedExecutionGrant } from "./approval-grant";

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
 *  automation workflow, or a non-low-impact write attempted unattended → deny).
 *
 *  `grant` (D14-04) is a VERIFIED single-use execution grant — the hub's tool-call site verified it
 *  against THIS call's tool name and args before calling in (see approval-grant.ts; the type is
 *  branded so an unverified object cannot reach here). Its ONLY effect is to skip the impact-suspend
 *  branch below: the write was already approved by a human, so it is no longer "unattended". Nothing
 *  else changes — assurance rank, workflow scope and (in authorizeCall) Cerbos are untouched. */
export function authorize(principal: Principal, toolName: string, grant?: VerifiedExecutionGrant): Decision {
  const tool = getTool(toolName);
  if (!tool) return { allow: false, reason: `unknown tool: ${toolName}` };
  if (RANK[principal.assurance] < RANK[tool.minAssurance]) {
    return {
      allow: false,
      reason: `denied: ${toolName} requires ${tool.minAssurance} assurance; caller has ${principal.assurance} (step up on a verified surface)`,
    };
  }
  // n8n-SPECIFIC: the workflow allow-list. Stays keyed on `isAutomation` because a per-workflow scope
  // is exactly an n8n concept — an agent has no `wf:*` id to look up.
  if (isAutomation(principal.provider)) {
    if (!workflowScope(principal.externalId).includes(tool.name)) {
      return { allow: false, reason: `denied: workflow ${principal.externalId} is not scoped for ${toolName}` };
    }
  }

  // ── THE IMPACT GATE (§3 / D14) — 2026-08-20: MOVED OUT OF THE isAutomation BLOCK ────────────────
  //
  // Unattended callers run LOW-impact writes only; medium/high and unclassified writes suspend for
  // human approval. D14-04: a verified execution grant for THIS tool means a human already lifted the
  // gate for exactly this call, so the write is no longer unattended and this branch (and ONLY this
  // branch) is skipped.
  //
  // ⚠ THE DEFECT THIS FIXES, and it was live. This branch used to sit INSIDE
  // `if (isAutomation(principal.provider))`, i.e. inside `provider === "n8n"`. But `runAgent` sends the
  // requesting HUMAN's envelope verbatim — deliberately, so an agent can never out-rank the person it
  // serves — so an agent-driven call arrived as `provider: "whatsapp"` and skipped the gate entirely.
  // An n8n workflow calling a HIGH-impact write suspended for approval; an agent calling the SAME tool
  // ran it unattended. The tier-based protection was unenforceable against precisely the caller D14
  // exists for, and the shipping of `iam.grantRole` (high) made that concrete.
  //
  // `isUnattended` is the right predicate: n8n OR agent-driven. A human on an interactive surface is
  // attended by definition and does not need their own approval to do what they just asked for.
  if (isUnattended(principal) && tool.write && tool.impact !== "low" && !grantAuthorizesTool(grant, toolName)) {
    const tier = tool.impact ?? "unclassified";
    const who = principal.agent ? `agent ${principal.agent}` : "automation";
    return {
      allow: false,
      reason: `suspend: ${toolName} is a ${tier}-impact write; ${who} requires human approval (only low-impact writes run unattended)`,
    };
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

/** Per-call decision, Cerbos-authoritative when configured; in-code reason preserved.
 *
 *  `grant` is threaded into BOTH encodings of the D14 impact gate — the in-code branch above
 *  (D14-04) and the `mcp_tool` policy's impact conjunct via the `approvalId` resource attribute
 *  (D14-13). That is required, not belt-and-braces: Cerbos is authoritative whenever CERBOS_URL is
 *  set, so lifting the suspension in code alone would still leave every granted automation re-drive
 *  Cerbos-DENIED. A Cerbos deny STILL denies with a grant present — the grant only ever removes the
 *  policy's "unattended write" objection, never any other condition (assurance, workflow scope), and
 *  only for the explicit executable-tool list the policy names. When there is no grant the Cerbos
 *  request payload is byte-for-byte what it was before D14-13 (the attribute key is omitted). */
export async function authorizeCall(
  principal: Principal,
  toolName: string,
  grant?: VerifiedExecutionGrant,
): Promise<Decision> {
  const inCode = authorize(principal, toolName, grant);
  if (!cerbosEnabled()) return inCode;
  const tool = getTool(toolName);
  if (!tool) return inCode; // unknown tool — in-code already denies with the right message
  try {
    const allow = await cerbosAllowsTool(principal, tool, grant);
    if (allow) return { allow: true, tool };
    // Cerbos denied. If in-code also denied, keep its rich reason (stepup / not-scoped / suspend);
    // otherwise (a policy drift) return a generic denial — fail closed.
    return inCode.allow ? { allow: false, reason: `denied by policy: ${toolName}` } : inCode;
  } catch (err) {
    console.warn(`[policy] cerbos call check failed (${(err as Error).message}) — using in-code policy`);
    return inCode;
  }
}
