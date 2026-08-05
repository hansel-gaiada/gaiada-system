// WS8 Step B — running a WRITE-CAPABLE specialist safely (D13 + D14 together).
//
// D14 (already in the runner): a high_write throws ApprovalRequiredError and commits nothing. This
// wrapper turns that suspension into a DURABLE, human-decidable record by filing it through the
// mcp-hub `approvals.request` tool (origin="agent") — the SAME platform automation_approvals inbox
// WS4 automation uses (generalized, not duplicated). The agent still commits nothing; a human
// approves/rejects in platform-ui.
//
// D14-10 UPDATE — the resume path is no longer deferred to Temporal. Under the owner's locked D14-b
// decision a suspended goal is resumed by RE-RUNNING IT FROM THE TOP, and `agent.ts` now consults the
// platform (`AgentDeps.resolveApproval`) before throwing. Consequences for THIS file:
//
//   * `ApprovalRequiredError` is now raised ONLY when no decided row binds the exact call, so
//     `fileApproval` below can no longer file a duplicate for a call a human already decided. The
//     re-file that made re-run useless is gone by construction, not by a check added here.
//   * A resumed run reaches `status: "completed"` with `run.approvals` populated, surfaced as
//     `resumed` on the result so a caller can distinguish "completed having performed a human-approved
//     write" (and whether its result was freshly executed or reused) from "completed doing reads".
//   * `ApprovalNotResumableError` (approved-but-stuck: executing / failed / no registry entry)
//     deliberately PROPAGATES. It must not be caught and turned into a filing: there is already a row
//     for this call, and a human — not this wrapper — is the one who unsticks it (D14-07 retry).
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
  type ApprovalConsumption,
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
  /** D14-10: `resumed` is present ONLY when this run turned one or more decided approvals into
   *  progress — the consumed-result path made visible at the result level instead of buried in
   *  `run.steps`. Optional (never a new variant) on purpose: `runner/service.ts`'s `mapWriteResult`
   *  exhausts this union with an `else`, so a fourth variant would silently be treated as
   *  `suspended` and dereference a `filed` that isn't there. Additive field, no consumer breaks. */
  | { status: "completed"; run: AgentRun; resumed?: ApprovalConsumption[] }
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
    // D14-10: surface the consumed/executed approvals when there were any. `run.approvals` is absent
    // on every run that resolved nothing, so this stays undefined for all pre-existing behaviour.
    return run.approvals?.length ? { status: "completed", run, resumed: run.approvals } : { status: "completed", run };
  } catch (err) {
    // ApprovalRequiredError now means "NO decided row binds this exact call" (agent.ts consults
    // first), so this filing can no longer duplicate a decision a human already made.
    // ApprovalNotResumableError is deliberately NOT caught here — see this file's header.
    if (err instanceof ApprovalRequiredError) {
      const filed = await fileApproval(deps, envelope, tenantId, def.name, err);
      return { status: "suspended", filed };
    }
    throw err;
  }
}
