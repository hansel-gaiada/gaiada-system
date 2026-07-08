// MCP hub client (surface side). The bot NEVER asserts identity (D4): it forwards the
// sender's (provider, external_id) envelope; the platform decides who that is and what
// they may see. Raw stateless JSON-RPC tools/call; responses arrive SSE-framed.
import { config } from "./config";

export interface HubEnvelope {
  provider: "whatsapp" | "telegram";
  externalId: string;
}

export class HubDeniedError extends Error {}

function parseSse(raw: string): { result?: { isError?: boolean; content?: Array<{ text?: string }> } } {
  const line = raw.split("\n").find((l) => l.startsWith("data:")) ?? "";
  if (!line) throw new Error("hub returned no data frame");
  return JSON.parse(line.slice(5).trim()) as ReturnType<typeof parseSse>;
}

export async function callHubTool(
  tool: string,
  args: Record<string, unknown>,
  envelope: HubEnvelope,
): Promise<string> {
  const res = await fetch(`${config.hubUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.hubServiceToken}`,
      "x-obo-provider": envelope.provider,
      "x-obo-external-id": envelope.externalId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) throw new Error(`hub ${res.status}`);
  const rpc = parseSse(await res.text());
  const text = rpc.result?.content?.[0]?.text ?? "";
  if (rpc.result?.isError) throw new HubDeniedError(text || "denied");
  return text;
}
