// MCP surface bound to ONE principal. Every request handler consults the policy with
// that principal: list advertises only what it may call; calls are authorized again and
// audited either way. The server never trusts anything the MCP client asserts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "./principal";
import { visibleTools, authorize } from "./policy";
import { auditToolCall, principalRef } from "./audit";

export function buildHubServer(principal: Principal): Server {
  const server = new Server({ name: "gaiada-mcp-hub", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(principal).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const decision = authorize(principal, name);
    if (!decision.allow) {
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "deny", reason: decision.reason });
      return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
    }
    try {
      const text = await decision.tool.handler((req.params.arguments as Record<string, unknown>) ?? {}, principal);
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "allow", ok: true });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "allow", ok: false });
      return { content: [{ type: "text" as const, text: `tool failed: ${(err as Error).message}` }], isError: true };
    }
  });

  return server;
}
