// Live bindings: models via the AI Gateway, tools via the MCP hub (OBO envelope).
// The agent process holds NO provider keys and NO database access — by construction.
import "dotenv/config";
import type { AgentDeps, Envelope } from "./agent";

const config = {
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3002",
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  hubUrl: process.env.HUB_URL ?? "http://localhost:3003",
  hubServiceToken: process.env.HUB_SERVICE_TOKEN ?? "",
};

async function complete(prompt: string): Promise<string> {
  const res = await fetch(`${config.gatewayUrl}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.gatewayToken}` },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

async function callTool(name: string, args: Record<string, unknown>, envelope: Envelope): Promise<string> {
  const res = await fetch(`${config.hubUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.hubServiceToken}`,
      "x-obo-provider": envelope.provider,
      "x-obo-external-id": envelope.externalId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`hub ${res.status}`);
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data:")) ?? "";
  const rpc = JSON.parse(line.slice(5).trim()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  const text = rpc.result?.content?.[0]?.text ?? "";
  if (rpc.result?.isError) throw new Error(text || "denied");
  return text;
}

export const liveDeps: AgentDeps = { complete, callTool };
