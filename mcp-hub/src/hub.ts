// MCP surface bound to ONE principal. Every request handler consults the policy with
// that principal: list advertises only what it may call; calls are authorized again and
// audited either way. The server never trusts anything the MCP client asserts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "./principal";
import { visibleToolsFor, authorizeCall } from "./policy";
import { auditToolCall, principalRef } from "./audit";
import { RESOURCE_TEMPLATES, canReadResources, readResource } from "./resources";
import { PROMPTS, canUsePrompts, getPrompt } from "./prompts";

export function buildHubServer(principal: Principal): Server {
  const server = new Server(
    { name: "gaiada-mcp-hub", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await visibleToolsFor(principal)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const decision = await authorizeCall(principal, name);
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

  // ---- Resources (§6): readable context, per-principal gated; the platform enforces per-instance authz.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: canReadResources(principal) ? RESOURCE_TEMPLATES : [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!canReadResources(principal)) {
      auditToolCall({ ts: Date.now(), tool: `resource:${uri}`, principal: principalRef(principal), decision: "deny", reason: "anonymous principals cannot read resources" });
      throw new Error("denied: identify yourself to read resources");
    }
    try {
      const text = await readResource(uri, principal);
      auditToolCall({ ts: Date.now(), tool: `resource:${uri}`, principal: principalRef(principal), decision: "allow", ok: true });
      return { contents: [{ uri, mimeType: "application/json", text }] };
    } catch (err) {
      auditToolCall({ ts: Date.now(), tool: `resource:${uri}`, principal: principalRef(principal), decision: "allow", ok: false });
      throw new Error(`resource read failed: ${(err as Error).message}`);
    }
  });

  // ---- Prompts (§6): reusable templates, no data access. Identified callers only.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: canUsePrompts(principal)
      ? PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments }))
      : [],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (!canUsePrompts(principal)) throw new Error("denied: identify yourself to use prompts");
    const prompt = getPrompt(req.params.name);
    if (!prompt) throw new Error(`unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments as Record<string, string>) ?? {};
    const missing = prompt.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
    if (missing.length) throw new Error(`missing required argument(s): ${missing.join(", ")}`);
    return {
      description: prompt.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.render(args) } }],
    };
  });

  return server;
}
