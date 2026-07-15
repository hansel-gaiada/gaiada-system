// WS8 Step B — running a WRITE-CAPABLE specialist safely (D13 + D14 together).
//
// D14 (already in the runner): a high_write throws ApprovalRequiredError and commits nothing. This
// wrapper turns that suspension into a DURABLE, human-decidable record by filing it through the
// mcp-hub `approvals.request` tool (origin="agent") — the SAME platform automation_approvals inbox
// WS4 automation uses (generalized, not duplicated). The agent still commits nothing; a human
// approves/rejects in platform-ui. (Auto-resuming an approved agent write is a Temporal concern,
// deferred — the approved row is the durable artifact a resume step reads.)
//
// D13 failover safety: a write-capable agent may run with its write tools ONLY on a provider that
// passed its eval suite + tool-calling contract (def.evaledProviders). On any other (un-evaled)
// provider it is forced READ-ONLY — its write tools are stripped from the allow-list, so an attempted
// write is contained as a typed refusal rather than executed by an unproven model.
import {
  runAgent,
  ApprovalRequiredError,
  type AgentDef,
  type AgentDeps,
  type AgentRun,
  type Envelope,
} from "./agent";

export function isWriteCapable(def: AgentDef): boolean {
  return Object.values(def.tools).some((impact) => impact !== "read");
}

/** A read-only projection of an agent: keep only its `read` tools (D13 forced-read-only). */
export function readOnlyProjection(def: AgentDef): AgentDef {
  const tools: AgentDef["tools"] = {};
  for (const [name, impact] of Object.entries(def.tools)) if (impact === "read") tools[name] = impact;
  return { ...def, name: `${def.name}(read-only)`, tools };
}

export interface FiledApproval {
  approvalId: string | null;
  tool: string;
  impact: string;
}

export type WriteAgentResult =
  | { status: "completed"; run: AgentRun }
  | { status: "suspended"; filed: FiledApproval }
  | { status: "forced_read_only"; run: AgentRun; reason: string };

/** File a pending approval for a suspended high_write, via the hub tool, under the caller's OBO. */
export async function fileApproval(
  deps: AgentDeps,
  envelope: Envelope,
  tenantId: string,
  agentName: string,
  err: ApprovalRequiredError,
): Promise<FiledApproval> {
  const raw = await deps.callTool(
    "approvals.request",
    {
      tenantId,
      workflowId: agentName, // the principal-side identifier of who was suspended
      toolName: err.tool,
      toolArgs: err.args,
      impact: err.impact,
      reason: err.message,
      origin: "agent",
      agentName,
    },
    envelope,
  );
  let approvalId: string | null = null;
  try {
    approvalId = (JSON.parse(raw) as { id?: string }).id ?? null;
  } catch {
    /* hub returned a non-JSON body; leave id null — the approval may still have been recorded */
  }
  return { approvalId, tool: err.tool, impact: String(err.impact) };
}

/**
 * Run a specialist that may hold write capability. `servingProvider` is the provider the Gateway will
 * use for this run (the caller supplies it — auto-detecting it from the Gateway response is the one
 * remaining runtime wire, see the WS8 plan). Enforces D13 (provider gate) then D14 (approval filing).
 */
export async function runWriteAgent(
  def: AgentDef,
  goal: string,
  envelope: Envelope,
  deps: AgentDeps,
  tenantId: string,
  servingProvider: string,
): Promise<WriteAgentResult> {
  if (isWriteCapable(def) && !(def.evaledProviders ?? []).includes(servingProvider)) {
    // D13: this provider has not been evaled for this write-capable agent — force read-only.
    const run = await runAgent(readOnlyProjection(def), goal, envelope, deps);
    return {
      status: "forced_read_only",
      run,
      reason: `provider "${servingProvider}" is not eval-cleared for ${def.name}; writes disabled (D13)`,
    };
  }
  try {
    const run = await runAgent(def, goal, envelope, deps);
    return { status: "completed", run };
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      const filed = await fileApproval(deps, envelope, tenantId, def.name, err);
      return { status: "suspended", filed };
    }
    throw err;
  }
}
