// Specialist-agent framework (WS8 §8.1) with D14 action safety built into the runner:
//  - tool ALLOW-LIST per agent; anything else is refused (typed, run stops)
//  - IMPACT TAXONOMY on every allow-listed tool; unclassified ⇒ approval required
//  - high-impact writes ⇒ approval required (human-in-loop; no silent commits)
//  - per-run STEP + TOOL-CALL budget; exhaustion raises a TYPED error carrying the
//    transcript — never a committed placeholder
// Models come via the Gateway, tools via the MCP hub with the requesting user's OBO
// envelope — an agent can never act with more authority than the human it serves.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2026-08-07 — an off-list tool NAME is a recoverable protocol slip, not a fatal one.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LIVE INCIDENT: the assistant's `task-filer` was driven with a real goal and the model called
// `mcp__gaiada__pm_listTasks` — a tool that exists on NEITHER this agent's allow-list NOR the hub's
// registry (`pm.listTasks` doesn't exist anywhere; the closest real tools are `tasks.list` and
// `pm.createTask`). The runner refused the call correctly (it was NEVER invoked — see below), but the
// refusal was, until this ticket, indistinguishable from every other allow-list violation: it threw
// `ToolNotAllowedError` and ended the WHOLE TURN. One naming guess killed a turn that had every fact it
// needed to answer the goal correctly with a valid tool name.
//
// THE FIX, and what does NOT change: an off-list call is now fed back to the model as a REFUSAL in the
// transcript (same "SYSTEM: ..." nudge idiom the malformed-JSON retry below already uses), naming the
// exact allow-listed tools so the model can retry with a real one — bounded by
// `MAX_OFF_LIST_ATTEMPTS` (2), after which the run fails exactly as before this ticket
// (`ToolNotAllowedError`, typed, run stops). Two invariants are unconditional and unchanged by this:
//   (1) the off-list tool is NEVER actually invoked — `deps.callTool` is not reached on this branch,
//       recoverable or not; only the REFUSAL is recoverable, never the containment.
//   (2) naming the valid tools in the refusal leaks nothing new: the full `Available tools` list is
//       already IN the model's own prompt every turn (`buildPrompt`, below) — repeating it in a
//       refusal cannot widen what the model can see or do.
// A genuine high-impact write still suspends for approval exactly as before (this block runs strictly
// before the impact gate and never touches it).
export const MAX_OFF_LIST_ATTEMPTS = 2;

export type Impact = "read" | "low_write" | "high_write";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-12 — reconcile an AgentDef's hand-maintained impact label against the hub registry's own
// classification for the same tool, STRICTER WINS, in both directions.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// THE GAP: `mcp-hub/src/policy.ts` gates the D14 impact suspend branch (`tool.write && impact !==
// "low"`) ONLY for automation principals (`provider === "n8n"`) — see `isAutomation` there. An agent
// principal is still gated by `minAssurance` and by Cerbos, but NOT by the registry's `impact` tier.
// So an agent's only impact classification is this file's `AgentDef.tools` map — hand-maintained,
// independent of the registry, and able to drift WEAKER than it. A tool an operator labels
// `low_write` here while the registry has since reclassified `impact: "high"` would execute
// unattended forever. This block closes that drift agent-side; it changes NOTHING in mcp-hub's own
// authorization path (explicit non-goal — see the ticket).
//
// THE TWO VOCABULARIES DO NOT MAP 1:1 — state the mapping explicitly rather than assume a shared enum
// (the platform/hub assurance vocabularies already disagree the same way: low|linked|high vs
// anonymous|low|verified):
//
//   Hub registry (`mcp-hub/src/registry.ts`):  write?: boolean;  impact?: "low" | "medium" | "high"
//   AgentDef (this file):                        Impact = "read" | "low_write" | "high_write"
//
// Mapping (registryImpactRank below):
//   registry write:false, or the tool absent from the registry entirely  → "read"     (no write
//     opinion at all — the agent's own label is authoritative; this is what makes an UNREGISTERED
//     tool fall back to the AgentDef label, fail-closed relative to today, never fail-open)
//   registry write:true, impact:"low"                                    → "low_write"
//   registry write:true, impact:"medium" | "high" | undefined            → "high_write"
//     `undefined` on a write:true tool means UNCLASSIFIED. The hub's own gate already treats an
//     unclassified write exactly like "high" (`impact !== "low"` — see registry.ts's own comment:
//     "an unclassified write ... is treated as confirm-required by the automation gate"). Mapping
//     unclassified to the LOOSEST bucket instead of the STRICTEST would silently re-create the exact
//     weakening this ticket exists to close, so it maps to "high_write" — the strictest bucket, never
//     weaker than whatever the AgentDef declared.
//
// The effective impact used at the write gate is `max(declaredRank, registryRank)` — stricter wins in
// BOTH directions: a registry entry stricter than the AgentDef label promotes it (test: `low_write` +
// registry `"high"` ⇒ `high_write`); an AgentDef label stricter than the registry entry is left alone
// (test: `high_write` + registry `"low"` ⇒ stays `high_write`).
export interface RegistryToolImpact {
  write: boolean;
  impact?: "low" | "medium" | "high";
}

const IMPACT_RANK: Record<Impact, number> = { read: 0, low_write: 1, high_write: 2 };
const RANK_TO_IMPACT: readonly Impact[] = ["read", "low_write", "high_write"];

/** Map the hub registry's write/impact vocabulary onto the AgentDef Impact scale's strictness rank.
 *  See the block comment above for the full mapping rationale. */
function registryImpactRank(reg: RegistryToolImpact | undefined): number {
  if (!reg || !reg.write) return IMPACT_RANK.read;
  if (reg.impact === "low") return IMPACT_RANK.low_write;
  return IMPACT_RANK.high_write; // "medium" | "high" | undefined (unclassified)
}

/**
 * D14-12 — the effective impact for a tool call: the STRICTER of the AgentDef's own declared label
 * and the hub registry's classification for the SAME tool name. Exported (pure, no I/O) so the
 * mapping can be unit-tested directly rather than only observed through `runAgent`'s side effects.
 */
export function effectiveImpact(declared: Impact, registry: RegistryToolImpact | undefined): Impact {
  const rank = Math.max(IMPACT_RANK[declared], registryImpactRank(registry));
  return RANK_TO_IMPACT[rank];
}

export interface AgentDef {
  name: string;
  systemPrompt: string;
  /** Tool name -> impact. Presence in this map IS the allow-list. */
  tools: Record<string, Impact>;
  maxSteps: number; // model calls per run
  maxToolCalls: number;
  /** D13 — providers that have passed THIS agent's eval suite + tool-calling contract test and may
   *  therefore serve it while it holds write capability. Empty/omitted ⇒ no provider is cleared, so a
   *  write-capable agent is forced read-only until an operator evals one (see runWriteAgent). Ignored
   *  for read-only agents. */
  evaledProviders?: string[];
}

export interface Envelope {
  provider: string;
  externalId: string;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-10 — the approval resolution contract (agent side).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// STRUCTURALLY IDENTICAL to `ApprovalResolution` in
// `platform-nest/src/core/automation-approvals.controller.ts` (the `POST
// :tenantId/automation-approvals/resolve-and-execute` response). It is duplicated rather than
// imported because these are separate standalone projects, not a shared-package monorepo — edit the
// two together; each side's header names the other.
//
// WHY THE RUNNER ASKS AT ALL: the owner's locked D14-b decision resumes a suspended goal by RE-RUNNING
// IT FROM THE TOP. Before this, the `high_write` gate below threw unconditionally, so a re-run
// replayed steps 1..N-1, re-suspended at N and filed a SECOND approval — it could never pass its own
// suspension point. Consulting the platform first is what turns a re-run into forward progress.
//
// THE PLATFORM, NOT THE RUNNER, IS THE AUTHORITY. This type carries no capability: the runner cannot
// execute a `high_write` itself in ANY branch. It either receives a result the platform produced
// (`executed`), or it does not proceed with that call. That is deliberate — a runner-side "the
// approval said yes, so I'll call the tool myself" branch would have no single-use enforcement and
// would re-execute on every re-run.
export type ApprovalResolution =
  /** Nothing decided binds this exact call ⇒ the runner does exactly what it always did: throw
   *  `ApprovalRequiredError`, and `write-agent.ts` files one approval. */
  | { match: "none" }
  /** Done. `result` is the tool's own return payload, read from the approval row's stored
   *  `execution_result` whether the platform executed it during THIS call (`consumed: false`) or had
   *  already executed it (`consumed: true`). Same column both ways, so the runner cannot behave
   *  differently in the two orders of the executor-vs-re-run race. */
  | { match: "executed"; approvalId: string; consumed: boolean; result: string; truncated: boolean }
  /** A human REJECTED this exact call. Typed refusal into the transcript; never re-filed.
   *  `reason` is the SUSPENSION reason the row was FILED with (the platform has no rejection-comment
   *  column), so it is deliberately NOT put in the model's refusal sentence — presenting "requires
   *  human approval" as the grounds for refusal would be actively misleading to the model. */
  | { match: "rejected"; approvalId: string; reason: string }
  /** Another executor holds the claim right now. */
  | { match: "executing"; approvalId: string }
  /** Execution was attempted and failed terminally — a human retries (D14-07), not the agent. */
  | { match: "failed"; approvalId: string; error: string }
  /** Approved, but the tool has no platform executable-registry entry, so nothing can execute it. */
  | { match: "not_executable"; approvalId: string; reason: string };

export interface AgentDeps {
  /** LLM completion via the AI Gateway (never a raw provider). */
  complete(prompt: string): Promise<string>;
  /** MCP hub tool call, carrying the OBO envelope. */
  callTool(name: string, args: Record<string, unknown>, envelope: Envelope): Promise<string>;
  /** The provider the Gateway actually served the last completion with (after any failover), when it
   *  reported one — used for D13 attribution + WS9. Optional so scripted/test deps can omit it. */
  lastProvider?: () => string | undefined;
  /**
   * D14-10 — ask the platform whether a DECIDED approval already binds this exact call, and (when one
   * is approved and unexecuted) have the platform execute it and hand back the result.
   *
   * OPTIONAL, and its absence is not a degraded mode: with no resolver the `high_write` gate behaves
   * EXACTLY as it did before this ticket (throw + file). That is the specified fallback, so every
   * caller that has not been wired yet keeps today's semantics rather than silently changing.
   *
   * MUST NOT swallow faults as `{ match: "none" }`. `none` means "file a fresh approval", so mapping a
   * transport error, a 403, or an unknown-tool response onto it re-creates the duplicate-approval
   * generator through the error path. An implementation that cannot get a definite answer must THROW.
   */
  resolveApproval?(input: {
    agentName: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }): Promise<ApprovalResolution>;
  /**
   * D14-12 — the hub registry's write/impact classification for one tool, keyed by the SAME name used
   * in `AgentDef.tools`. SYNCHRONOUS and side-effect-free by contract: the runner calls this on every
   * tool dispatch, so an implementation MUST read from an already-warm, in-memory snapshot (e.g. a
   * cache a background bootstrap refreshes — see `ai-agents/src/deps.ts`'s
   * `startRegistryImpactBootstrap`) rather than making a network call here. That is also why this is
   * OPTIONAL rather than async-required: its absence (or an empty/never-populated cache) is NOT a
   * degraded mode — every tool then falls back to its AgentDef label exactly as before this ticket,
   * so a cold cache or an unreachable hub degrades to today's behaviour, never to a hard dependency on
   * hub availability at agent startup or mid-run.
   */
  getRegistryImpact?(toolName: string): RegistryToolImpact | undefined;
}

export interface AgentStep {
  kind: "model" | "tool";
  detail: string;
}

/** D14-10 — one `high_write` that a decided approval resolved during this run. Present so a caller can
 *  tell "the goal completed and a human-approved write actually happened" from "the goal completed
 *  doing only reads", and so `consumed` (the result came from a PRIOR execution) is visible rather
 *  than inferred. Additive: absent on runs that resolved nothing. */
export interface ApprovalConsumption {
  tool: string;
  approvalId: string;
  /** `executed` — the platform executed it on this run's request.
   *  `consumed` — it was already executed; the stored result was reused, the tool NOT re-called.
   *  `rejected` — a human refused this exact call; the run continued without it. */
  outcome: "executed" | "consumed" | "rejected";
}

export interface AgentRun {
  outcome: string;
  steps: AgentStep[];
  /** D14-10; omitted when no approval was resolved (every run before this ticket). */
  approvals?: ApprovalConsumption[];
}

export class ToolNotAllowedError extends Error {
  constructor(tool: string, public steps: AgentStep[]) {
    super(`tool not on the agent's allow-list: ${tool}`);
  }
}

export class ApprovalRequiredError extends Error {
  constructor(
    public tool: string,
    public impact: Impact | "unclassified",
    public args: Record<string, unknown>,
    public steps: AgentStep[],
  ) {
    super(`tool ${tool} (${impact}) requires human approval — run suspended, nothing committed`);
  }
}

/**
 * D14-10 — a decided approval binds this call, but it cannot be turned into forward progress right
 * now. LOUD and typed rather than a transcript note, because none of these states is something the
 * model can route around, and letting it try would invite a near-miss variant of a write a human
 * already gated:
 *
 *  - `executing`       another executor holds the claim. Re-run later; it will find `executed`.
 *  - `failed`          execution was attempted and failed. A HUMAN retries via D14-07, whose retry
 *                      re-evaluates the server-side precondition first — the only safe form, because
 *                      a `tool_error`/`hub_unreachable` failure may have partially applied.
 *  - `not_executable`  approved, but the tool has no entry in
 *                      `platform-nest/src/core/approval-executables.ts`, so the platform has nothing
 *                      to execute it with. Fail closed: the runner must NOT call the tool itself.
 *
 * Deliberately NOT an `ApprovalRequiredError` subclass — `write-agent.ts` files an approval on that
 * class, and re-filing here would be the duplicate-generator this ticket removes.
 */
export class ApprovalNotResumableError extends Error {
  constructor(
    public tool: string,
    public approvalId: string,
    public state: "executing" | "failed" | "not_executable",
    public detail: string,
    public steps: AgentStep[],
  ) {
    super(
      `tool ${tool} has an approved decision (${approvalId}) that cannot be resumed: ${state}` +
        (detail ? ` — ${detail}` : "") +
        " — run suspended, nothing re-filed",
    );
  }
}

export class BudgetExhaustedError extends Error {
  constructor(which: "steps" | "toolCalls", public steps: AgentStep[]) {
    super(`per-run ${which} budget exhausted — run suspended for human resume, nothing committed`);
  }
}

export class ModelProtocolError extends Error {
  constructor(public steps: AgentStep[]) {
    super("model failed to produce a valid action twice — run aborted");
  }
}

interface ModelAction {
  tool?: string;
  args?: Record<string, unknown>;
  final?: string;
}

function parseAction(raw: string): ModelAction | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as ModelAction;
    if (typeof parsed.final === "string" || typeof parsed.tool === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function buildPrompt(def: AgentDef, goal: string, transcript: string[]): string {
  const toolLines = Object.entries(def.tools)
    .map(([name, impact]) => `- ${name} (${impact})`)
    .join("\n");
  return `${def.systemPrompt}

You work in strict steps. Reply with EXACTLY ONE JSON object and nothing else:
  {"tool": "<name>", "args": {...}}   to use a tool, or
  {"final": "<your finished answer>"} when done.

Available tools:
${toolLines}

GOAL: ${goal}

TRANSCRIPT SO FAR:
${transcript.join("\n") || "(none)"}`;
}

export async function runAgent(
  def: AgentDef,
  goal: string,
  envelope: Envelope,
  deps: AgentDeps,
): Promise<AgentRun> {
  const steps: AgentStep[] = [];
  const transcript: string[] = [];
  const approvals: ApprovalConsumption[] = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let protocolRetries = 0;
  // 2026-08-07 — bounded recoverable retries for an off-allow-list tool NAME (see this file's header
  // block). Independent of `protocolRetries` (a different failure shape: malformed JSON vs. a
  // well-formed action naming a tool that doesn't exist here) and never reset mid-run — the cap is on
  // total off-list guesses for the whole goal, not per distinct name.
  let offListAttempts = 0;

  /** Attach D14-10's resolution record only when there is one, so a run that resolved nothing is
   *  byte-identical to a pre-ticket run. */
  const finish = (outcome: string): AgentRun =>
    approvals.length ? { outcome, steps, approvals } : { outcome, steps };

  for (;;) {
    if (modelCalls >= def.maxSteps) throw new BudgetExhaustedError("steps", steps);
    modelCalls++;
    const raw = await deps.complete(buildPrompt(def, goal, transcript));
    steps.push({ kind: "model", detail: raw.slice(0, 200) });

    const action = parseAction(raw);
    if (!action) {
      if (protocolRetries++ >= 1) throw new ModelProtocolError(steps);
      transcript.push("SYSTEM: your last reply was not a valid JSON action. Reply with one JSON object only.");
      continue;
    }
    protocolRetries = 0;

    if (action.final !== undefined) return finish(action.final);

    const tool = action.tool!;
    const declaredImpact = def.tools[tool];
    if (declaredImpact === undefined) {
      // Not on the allow-list at all. `deps.callTool` is NEVER reached on this branch, recoverable or
      // not — see this file's 2026-08-07 header block. A bounded number of attempts get fed back as a
      // typed refusal so a model that GUESSES a plausible-but-wrong name (e.g. inventing `pm.listTasks`
      // by analogy from `pm.createTask`) can recover with a real one instead of losing the whole turn.
      // Past the cap this is exactly the pre-ticket behaviour: refuse outright, run stops. If the model
      // invented a write tool, this is also the "unclassified ⇒ confirmation required" path (D14).
      if (offListAttempts < MAX_OFF_LIST_ATTEMPTS) {
        offListAttempts++;
        transcript.push(
          `TOOL ${tool} REFUSED: "${tool}" is not on your allow-list and was NOT called — nothing ` +
            `executed. Your available tools are exactly: ${Object.keys(def.tools).join(", ")}. Reply ` +
            "with one of those exact tool names, or {\"final\": ...} if you already have enough " +
            "information to answer.",
        );
        continue;
      }
      throw new ToolNotAllowedError(tool, steps);
    }
    // D14-12 — reconcile against the hub registry BEFORE the gate below sees it, stricter of the two
    // wins in both directions. `deps.getRegistryImpact` is optional and synchronous (see AgentDeps'
    // doc); its absence, or the tool being absent from the registry, leaves `impact === declaredImpact`
    // — today's exact behaviour, never weaker.
    const impact = effectiveImpact(declaredImpact, deps.getRegistryImpact?.(tool));
    if (impact === "high_write") {
      const args = action.args ?? {};
      // D14-10 — CONSULT BEFORE THROWING. With no resolver wired this is `{ match: "none" }`, i.e.
      // exactly the pre-ticket line: `throw new ApprovalRequiredError(...)`.
      const resolution: ApprovalResolution = deps.resolveApproval
        ? await deps.resolveApproval({ agentName: def.name, toolName: tool, toolArgs: args })
        : { match: "none" };

      if (resolution.match === "none") throw new ApprovalRequiredError(tool, impact, args, steps);

      if (resolution.match === "executed") {
        // The platform ran it (or replayed a prior run's stored result). The runner NEVER calls the
        // tool on this path — that is the whole single-use guarantee.
        //
        // `toolCalls` is incremented but NOT pre-checked against the budget: refusing to deliver a
        // result the platform has already produced would strand a human-approved write with no record
        // in the transcript, which is worse than exceeding a budget meant to cap model-driven tool
        // spam. `maxSteps` still terminates every loop, so nothing here is unbounded.
        toolCalls++;
        approvals.push({ tool, approvalId: resolution.approvalId, outcome: resolution.consumed ? "consumed" : "executed" });
        // Deliberately the SAME `<tool> ok` step vocabulary a directly-executed tool produces:
        // `runner/service.ts`'s `traceFromRun` parses that suffix to build `toolsCalled`, and an
        // approval-specific spelling would corrupt every trace rather than enrich it. The precise
        // fact lives in `approvals` above.
        steps.push({ kind: "tool", detail: `${tool} ok` });
        transcript.push(
          `TOOL ${tool}(${JSON.stringify(args)}) => ${resolution.result.slice(0, 2000)}` +
            (resolution.truncated ? " [result truncated]" : "") +
            ` [executed under human approval ${resolution.approvalId}${resolution.consumed ? ", result reused from the approved execution — the tool was NOT called again" : ""}]`,
        );
        continue;
      }

      if (resolution.match === "rejected") {
        // A human refused this exact call. The run CONTINUES (the model may finish, or choose a
        // legitimately different action) but nothing is re-filed — asking a human a second time for a
        // write they already refused is the duplicate-approval defect wearing a different hat.
        toolCalls++;
        approvals.push({ tool, approvalId: resolution.approvalId, outcome: "rejected" });
        steps.push({ kind: "tool", detail: `${tool} failed` });
        // `resolution.reason` is deliberately NOT interpolated — see the type's doc. The model needs
        // exactly two facts: it was refused by a human, and re-asking is not an option.
        transcript.push(
          `TOOL ${tool}(${JSON.stringify(args)}) REFUSED: a human REJECTED this exact call (approval ${resolution.approvalId}). ` +
            "Do NOT request it again with the same arguments — choose a different action or finish.",
        );
        continue;
      }

      throw new ApprovalNotResumableError(
        tool,
        resolution.approvalId,
        resolution.match,
        resolution.match === "failed" ? resolution.error : resolution.match === "not_executable" ? resolution.reason : "",
        steps,
      );
    }

    if (toolCalls >= def.maxToolCalls) throw new BudgetExhaustedError("toolCalls", steps);
    toolCalls++;
    try {
      const result = await deps.callTool(tool, action.args ?? {}, envelope);
      steps.push({ kind: "tool", detail: `${tool} ok` });
      transcript.push(`TOOL ${tool}(${JSON.stringify(action.args ?? {})}) => ${result.slice(0, 2000)}`);
    } catch (err) {
      steps.push({ kind: "tool", detail: `${tool} failed` });
      transcript.push(`TOOL ${tool} FAILED: ${(err as Error).message}`);
    }
  }
}
