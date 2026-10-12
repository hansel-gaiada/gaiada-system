// Client for the AI Gateway (WS3). AI-backed hub tools go THROUGH the Gateway — the hub
// holds no provider keys (D8); the Gateway applies DLP, failover, cost cap, and audit.
import { config } from "./config";

async function post(path: string, body: unknown): Promise<string> {
  const res = await fetch(`${config.gatewayUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway ${path} ${res.status}`);
  const data = (await res.json()) as { text?: string };
  if (typeof data.text !== "string") throw new Error(`gateway ${path} returned no text`);
  return data.text;
}

// The gateway's keyless terminator (ai-gateway-go providers/echo.go) answers "[echo — no provider key configured] <prompt>".
const ECHO_PREFIX = "[echo — no provider key configured]";

// Text generation through /complete. A generation that is empty after trim, or that is the gateway's echo fallback
// (no real provider produced it), is a FAILURE here: no brief, PRD, report, scope or summary is ever legitimately
// either, and storing one opens the next stage on a blank artifact (M6-P4n, live 2026-10-13). The throw fails the tool,
// n8n's node errors, the webhook answers 5xx and platform-nest's at-least-once bridge redelivers: a bounded retry.
export async function gatewayComplete(prompt: string): Promise<string> {
  const raw = await post("/complete", { prompt });
  if (!raw.trim()) throw new Error("gateway /complete: the model returned no text");
  if (raw.trimStart().startsWith(ECHO_PREFIX)) {
    throw new Error("gateway /complete: the gateway answered with its echo fallback: no real provider produced this");
  }
  return raw;
}
export const gatewayMedia = (base64: string, mime: string): Promise<string> => post("/media", { base64, mime });
