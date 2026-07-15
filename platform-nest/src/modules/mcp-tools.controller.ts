// WS2 §6 — MCP tool-def aggregation. The hub fetches this at boot to advertise every compiled-in
// module's contributed tools (ModuleContract.mcpTools) generically, instead of hardcoding them.
// Service-token gated (the hub calls it with PLATFORM_SERVICE_TOKEN, no end user). Returns the
// UNION of all modules' tool defs; per-TENANT module enablement is still enforced at call time by
// the module's own controller (a call to a disabled module 403s, which the hub surfaces).
import { Controller, Get, UseGuards } from "@nestjs/common";
import { ServiceGuard } from "../auth/guards";
import { allModules } from "./registry";
import type { McpToolDef } from "./contract";

@Controller("mcp")
@UseGuards(ServiceGuard)
export class McpToolsController {
  @Get("tool-defs")
  toolDefs(): McpToolDef[] {
    return allModules().flatMap((m) => m.mcpTools);
  }
}
