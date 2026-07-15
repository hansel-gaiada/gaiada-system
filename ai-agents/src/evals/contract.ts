// WS8 Step A — the tool-calling contract check (D13, the second half of the failover gate).
//
// D13: a provider may be a FAILOVER TARGET for a write-capable agent only after it passes that
// agent's eval suite AND a tool-calling contract test; on failover to an un-evaled provider the
// agent is forced read-only / human-in-loop. This module is the contract half: given a candidate
// provider (modelled here as its scripted outputs over a representative goal), it asserts the
// provider speaks the agent's strict single-JSON-action protocol — no prose, no malformed calls,
// no invented tools. A provider that trips ModelProtocolError or ToolNotAllowedError fails the
// contract and must NOT be enrolled as a write-agent failover target.
import type { AgentDef, Envelope } from "../agent";
import { traceRun } from "./trace";
import { caseDeps, type EvalCase } from "./harness";

export interface ContractResult {
  provider: string;
  agent: string;
  wellFormed: boolean;
  reason: string | null;
}

/**
 * Run `agent` against a candidate provider's scripted outputs and decide whether the provider
 * honours the tool-calling contract. `probe` reuses the EvalCase shape (scripted model + fixtures)
 * so a provider's contract fixtures live beside its evals.
 */
export async function checkToolContract(provider: string, agent: AgentDef, probe: Omit<EvalCase, "agent" | "expect" | "name">): Promise<ContractResult> {
  const c: EvalCase = { ...probe, name: `contract:${provider}:${agent.name}`, agent, expect: {} };
  const trace = await traceRun(`contract:${provider}:${agent.name}`, agent, c.goal, c.envelope, caseDeps(c));

  // A malformed provider trips the runner's protocol guard; an invented tool trips the allow-list.
  if (trace.status === "protocol_error") return { provider, agent: agent.name, wellFormed: false, reason: "provider did not emit a valid JSON action" };
  if (trace.status === "tool_not_allowed") return { provider, agent: agent.name, wellFormed: false, reason: "provider called a tool outside the agent's allow-list" };
  // "ok", "approval_required", "budget_exhausted" all mean the provider produced WELL-FORMED actions
  // (approval/budget are policy outcomes, not protocol failures).
  return { provider, agent: agent.name, wellFormed: true, reason: null };
}

/**
 * The D13 gate decision for enrolling a write-capable agent's failover targets: a provider is an
 * allowed target only if it clears BOTH its eval suite (caller passes the boolean) and the contract.
 */
export function allowedAsFailoverTarget(evalSuitePassed: boolean, contract: ContractResult): boolean {
  return evalSuitePassed && contract.wellFormed;
}
