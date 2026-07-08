// LLM intent router (Phase E): map a free-text message to ONE proposed action from the
// registered catalog. It never executes — it only proposes, so the result always flows
// through the same authorize → confirm → execute gauntlet as a /command. Anything the model
// returns is constrained to the allow-list and schema-validated; a malicious message cannot
// cause an unauthorized or unconfirmed mutation. Defensive parsing: any non-JSON / unknown
// action / low-confidence result degrades to "none" (fall back to Q&A) or "clarify".
import { config } from "../config";
import { complete as defaultComplete } from "../llm";
import { listActions, getAction } from "./registry";

export type IntentResult =
  | { kind: "action"; actionName: string; args: string | Record<string, unknown>; confidence: number }
  | { kind: "clarify"; question: string }
  | { kind: "none" };

export function buildCatalog(): string {
  return listActions()
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");
}

function buildPrompt(text: string): string {
  return [
    "You map a work-chat message to at most ONE action from this catalog:",
    buildCatalog(),
    "",
    "Reply with ONLY a JSON object, no prose. Shapes:",
    '- perform an action: {"action":"<name>","args":{...},"confidence":0.0-1.0}',
    '- need more info / ambiguous: {"action":"clarify","question":"<one short question>"}',
    '- not an action request: {"action":"none"}',
    "Never invent an action name outside the catalog. Only include args you can extract from the message.",
    "",
    `Message: ${text}`,
  ].join("\n");
}

/** Extract the first balanced JSON object from a model reply (tolerates surrounding prose). */
function extractJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function routeIntent(
  text: string,
  complete: (prompt: string) => Promise<string> = defaultComplete,
): Promise<IntentResult> {
  if (!config.intentRoutingEnabled || listActions().length === 0) return { kind: "none" };

  const reply = await complete(buildPrompt(text));
  const parsed = extractJson(reply) as
    | { action?: string; args?: string | Record<string, unknown>; confidence?: number; question?: string }
    | null;
  if (!parsed || typeof parsed.action !== "string") return { kind: "none" };

  const action = parsed.action.toLowerCase();
  if (action === "none") return { kind: "none" };
  if (action === "clarify") {
    return { kind: "clarify", question: parsed.question?.trim() || "Could you clarify what you'd like me to do?" };
  }
  if (!getAction(action)) return { kind: "none" }; // hallucinated action → ignore

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (confidence < config.intentConfidenceThreshold) {
    return { kind: "clarify", question: `Did you want me to run "${action}"? If so, please rephrase or use /${action.replace(".", " ")}.` };
  }
  return { kind: "action", actionName: action, args: parsed.args ?? {}, confidence };
}
