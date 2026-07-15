// Specialist-agent framework (WS8 §8.1) with D14 action safety built into the runner:
//  - tool ALLOW-LIST per agent; anything else is refused (typed, run stops)
//  - IMPACT TAXONOMY on every allow-listed tool; unclassified ⇒ approval required
//  - high-impact writes ⇒ approval required (human-in-loop; no silent commits)
//  - per-run STEP + TOOL-CALL budget; exhaustion raises a TYPED error carrying the
//    transcript — never a committed placeholder
// Models come via the Gateway, tools via the MCP hub with the requesting user's OBO
// envelope — an agent can never act with more authority than the human it serves.

export type Impact = "read" | "low_write" | "high_write";

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

export interface AgentDeps {
  /** LLM completion via the AI Gateway (never a raw provider). */
  complete(prompt: string): Promise<string>;
  /** MCP hub tool call, carrying the OBO envelope. */
  callTool(name: string, args: Record<string, unknown>, envelope: Envelope): Promise<string>;
  /** The provider the Gateway actually served the last completion with (after any failover), when it
   *  reported one — used for D13 attribution + WS9. Optional so scripted/test deps can omit it. */
  lastProvider?: () => string | undefined;
}

export interface AgentStep {
  kind: "model" | "tool";
  detail: string;
}

export interface AgentRun {
  outcome: string;
  steps: AgentStep[];
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
  let modelCalls = 0;
  let toolCalls = 0;
  let protocolRetries = 0;

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

    if (action.final !== undefined) return { outcome: action.final, steps };

    const tool = action.tool!;
    const impact = def.tools[tool];
    if (impact === undefined) {
      // Not on the allow-list at all — refuse outright. If the model invented a write
      // tool, this is also the "unclassified ⇒ confirmation required" path (D14).
      throw new ToolNotAllowedError(tool, steps);
    }
    if (impact === "high_write") throw new ApprovalRequiredError(tool, impact, action.args ?? {}, steps);

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
