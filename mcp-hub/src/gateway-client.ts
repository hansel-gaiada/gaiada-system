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

export const gatewayComplete = (prompt: string): Promise<string> => post("/complete", { prompt });
export const gatewayMedia = (base64: string, mime: string): Promise<string> => post("/media", { base64, mime });
