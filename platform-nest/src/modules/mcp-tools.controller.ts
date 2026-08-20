// WS2 §6 — MCP tool-def aggregation. The hub fetches this at boot to advertise every compiled-in
// module's contributed tools (ModuleContract.mcpTools) generically, instead of hardcoding them.
// Service-token gated (the hub calls it with PLATFORM_SERVICE_TOKEN, no end user). Returns the
// UNION of all modules' tool defs; per-TENANT module enablement is still enforced at call time by
// the module's own controller (a call to a disabled module 403s, which the hub surfaces).
//
// P2-07 — the union now also includes CORE-owned tools (`src/core/core-tools.ts`). Modules were the
// only possible owner before, which left `positions` and `role-grants` — core controllers over core
// tables — with nowhere to be declared and therefore unreachable to an agent. A core tool has no
// per-tenant enablement gate, because core has no flag to consult; see core-tools.ts for what that
// means for whoever adds one.
import { Controller, Get, UseGuards } from "@nestjs/common";
import { ServiceGuard } from "../auth/guards";
import { allModules } from "./registry";
import { allCoreTools } from "../core/core-tools";
import type { McpToolDef } from "./contract";

@Controller("mcp")
@UseGuards(ServiceGuard)
export class McpToolsController {
  @Get("tool-defs")
  toolDefs(): McpToolDef[] {
    // Core first, then modules — a stable order, so a diff of this endpoint's output between two
    // releases reads as "what changed" rather than "what moved".
    const defs = [...allCoreTools(), ...allModules().flatMap((m) => m.mcpTools)];

    // A duplicate NAME would make the hub's advertised surface depend on registration order, and the
    // loser would be silently unreachable — the failure would look like "the tool exists but does the
    // wrong thing". Neither registry can see the other (core-tools.ts cannot import the module
    // registry without a cycle), so this is the one place that can check, and it throws rather than
    // de-duplicating: two owners for one tool name is a design mistake to fix, not a collision to
    // paper over.
    const seen = new Set<string>();
    for (const def of defs) {
      if (seen.has(def.name)) {
        throw new Error(
          `duplicate MCP tool name '${def.name}' — a core registration and a module both claim it, ` +
            `or one module declares it twice. Rename one; the hub cannot advertise both.`,
        );
      }
      seen.add(def.name);
    }
    return defs;
  }
}
