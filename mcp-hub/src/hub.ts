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
import { auditToolCall, principalRef, type GrantAudit } from "./audit";
import { RESOURCE_TEMPLATES, canReadResources, readResource } from "./resources";
import { PROMPTS, canUsePrompts, getPrompt } from "./prompts";
import { verifyExecutionGrant, type VerifiedExecutionGrant } from "./approval-grant";
import { validateToolArgs, invalidArgsMessage } from "./validate-args";

export interface HubServerOptions {
  /** Raw `x-approval-grant` header value from the tool call, if the caller sent one (D14-04).
   *  Verified HERE, at the call site, because verification binds the grant to the ACTUAL arguments.
   *  Absent ⇒ the authorization path is byte-for-byte today's. */
  approvalGrant?: string;
}

export function buildHubServer(principal: Principal, options: HubServerOptions = {}): Server {
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
    const args = (req.params.arguments as Record<string, unknown>) ?? {};

    // D14-04: verify a presented execution grant against THIS call (tool name + actual args) before
    // authorizing. A rejected grant is simply not a grant — authorization then takes today's exact
    // path with today's exact reason — but the verdict is always audited, accepted or rejected.
    let grant: VerifiedExecutionGrant | undefined;
    let grantAudit: GrantAudit | undefined;
    if (options.approvalGrant) {
      const verdict = verifyExecutionGrant(options.approvalGrant, { toolName: name, args });
      if (verdict.ok) {
        grant = verdict.grant;
        grantAudit = { verdict: "accepted", approvalId: verdict.grant.approvalId };
      } else {
        grantAudit = { verdict: "rejected", reason: verdict.reason, ...(verdict.approvalId ? { approvalId: verdict.approvalId } : {}) };
      }
    }

    const decision = await authorizeCall(principal, name, grant);
    if (!decision.allow) {
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "deny", reason: decision.reason, ...(grantAudit ? { grant: grantAudit } : {}) });
      return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
    }
    // ── ARGUMENT VALIDATION (2026-08-24), the one gate between MCP and a handler ──────────────────
    // Ordered AFTER authorization on purpose: a caller who may not call this tool learns only that,
    // never its argument names or shape. Validation failure is NOT a policy denial — the caller was
    // allowed and the request was malformed — so it audits as `allow` + `ok:false` with a reason,
    // keeping the deny-rate signal meaning "policy refused" and nothing else.
    // `checked.args` (defaults applied, `"5"` → `5`) is what the handler receives, so the string
    // interpolation every handler does can no longer produce `/api/undefined/...`.
    //
    // ⚠ IT IS ALSO AFTER THE D14-04 GRANT CHECK, AND THAT ORDER IS LOAD-BEARING. `argsSha256` binds
    // a grant to the EXACT args the approval was filed from — raw, because the suspending first
    // attempt never reached this line either. Verifying against `checked.args` instead would hash a
    // different object than the platform stored and fail every legitimate re-drive with
    // `args_mismatch`. Nothing is widened by the split: the grant still pins the raw bytes, and
    // validation is deterministic on them, so a caller cannot present args approved for one call
    // and have them coerce into another.
    const checked = validateToolArgs(decision.tool.inputSchema, args);
    if (!checked.ok) {
      const reason = invalidArgsMessage(name, checked.errors, decision.tool.inputSchema);
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "allow", ok: false, reason, ...(grantAudit ? { grant: grantAudit } : {}) });
      return { content: [{ type: "text" as const, text: reason }], isError: true };
    }
    try {
      const text = await decision.tool.handler(checked.args, principal);
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "allow", ok: true, ...(grantAudit ? { grant: grantAudit } : {}) });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      auditToolCall({ ts: Date.now(), tool: name, principal: principalRef(principal), decision: "allow", ok: false, ...(grantAudit ? { grant: grantAudit } : {}) });
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
