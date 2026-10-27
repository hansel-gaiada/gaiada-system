// Client for the AI Gateway (WS3). AI-backed hub tools go THROUGH the Gateway — the hub
// holds no provider keys (D8); the Gateway applies DLP, failover, cost cap, and audit.
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config"; // first: it loads .env before usage-reporter reads PLATFORM_URL
import { usageReporter } from "./usage-reporter";
import { usageEvent } from "./usage-event";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// AIP-03b — who a gateway call made from a tool is for, as the usage record needs it. The three AI-backed tools (llm.summarize, llm.extract,
// design.prototype) call `gatewayComplete(prompt)` with no room for it, so `hub.ts` opens this around the ONE place a tool handler runs
// (AsyncLocalStorage: concurrent calls never cross), exactly as ai-agents does for `tenantContext`.
//
//   tenant   the tool call's own `tenantId` argument, when it is a string. The agent runner stamps the run's company into EVERY tool call
//            (deps.ts `withRunTenant`), so an agent's call always has one. A caller that sends none (today: n8n's pipeline workflows, which do
//            not pass `tenantId` to llm.extract / design.prototype) has no company to bill: no row is written and the reporter says so once.
//            The hub never guesses a company from the envelope (a person may belong to several).
//   person   the envelope's external id when its provider is `platform` (the ERP's self-link, externalId = the user id); a chat identity is
//            not a user id. The platform stores it only if that person is a member of the tenant, else as null.
//   surface  `agent` when the hub minted the principal for an agent-driven call (`principal.agent`, the x-obo-agent header the runner sends:
//            "tools called by agents"); `other` for everything else (n8n, an MCP client, the bot).
//   task     the tool's name (`llm.summarize`).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
export interface ToolCallUsage { tool: string; tenantId: string | null; userId: string | null; agent: boolean }
export const toolCallUsage = new AsyncLocalStorage<ToolCallUsage>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toolCallUsageFor(tool: string, args: Record<string, unknown>, principal: { provider: string; externalId: string; agent?: string }): ToolCallUsage {
  return {
    tool,
    tenantId: typeof args.tenantId === "string" ? args.tenantId : null,
    userId: principal.provider === "platform" && UUID_RE.test(principal.externalId) ? principal.externalId : null,
    agent: typeof principal.agent === "string" && principal.agent !== "",
  };
}

async function post(path: string, body: unknown, capability: "llm" | "media"): Promise<string> {
  const who = toolCallUsage.getStore();
  let status: number | null = null; // null until the gateway answers: a network failure is an `error` row
  let data: { text?: string; provider?: string; usage?: unknown } | null = null;
  try {
    const res = await fetch(`${config.gatewayUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    status = res.status;
    if (!res.ok) throw new Error(`gateway ${path} ${res.status}`);
    data = (await res.json()) as { text?: string; provider?: string; usage?: unknown };
    if (typeof data.text !== "string") throw new Error(`gateway ${path} returned no text`);
    return data.text;
  } finally {
    // One usage event per gateway call, fire and forget (the reporter never throws and is never awaited).
    usageReporter.report(
      usageEvent({ tenantId: who?.tenantId, userId: who?.userId, surface: who?.agent ? "agent" : "other", capability, task: who?.tool }, status, data),
    );
  }
}

// The gateway's keyless terminator (ai-gateway-go providers/echo.go) answers "[echo — no provider key configured] <prompt>".
const ECHO_PREFIX = "[echo — no provider key configured]";

// Text generation through /complete. A generation that is empty after trim, or that is the gateway's echo fallback
// (no real provider produced it), is a FAILURE here: no brief, PRD, report, scope or summary is ever legitimately
// either, and storing one opens the next stage on a blank artifact (M6-P4n, live 2026-10-13). The throw fails the tool,
// n8n's node errors, the webhook answers 5xx and platform-nest's at-least-once bridge redelivers: a bounded retry.
export async function gatewayComplete(prompt: string): Promise<string> {
  const raw = await post("/complete", { prompt }, "llm");
  if (!raw.trim()) throw new Error("gateway /complete: the model returned no text");
  if (raw.trimStart().startsWith(ECHO_PREFIX)) {
    throw new Error("gateway /complete: the gateway answered with its echo fallback: no real provider produced this");
  }
  return raw;
}
export const gatewayMedia = (base64: string, mime: string): Promise<string> => post("/media", { base64, mime }, "media");
