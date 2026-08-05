// Assistant module contract (ASST-05). Routes live in AssistantController; this object carries
// the registry/rollup metadata (migrations, permissions, customFieldTargets, mcpTools,
// rollupProviders, uiManifest, eventHandlers) that the engine + registry + hub tool-def
// aggregation consume — same split as hrModule/pmModule (see modules/hr/index.ts).
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-05").
// Design: docs/blueprints/assistant-foundation.md §4 (data model), §6 (authorization).
//
// ── LEFT DELIBERATELY EMPTY (do not fill with a placeholder — see each reason) ───────────────────
//  - `mcpTools`: the assistant's OWN tool-broker surface ("a tool call is attributable to a user",
//    capabilities panel) is Phase 3 of the blueprint's build sequence (§9), owned by a future
//    ticket, not yet decomposed. Registering a tool here now would let the MCP hub aggregate a
//    tool this module has no authorized execution path behind yet (contract.ts's mcpTools is
//    consumed by GET /mcp/tool-defs regardless of whether the module's OWN controller can serve
//    the call it advertises).
//  - `rollupProviders`: no metric surface is specified for the assistant in blueprint phases 0-1;
//    a future ticket can add one (e.g. thread/message counts) if a department dashboard wants it.
//    Registering an empty-metric provider now would just be dead weight in syncMetricDefinitions().
//  - `customFieldTargets`: threads/messages/memory have no custom-field surface in the design.
//  - `eventHandlers`: ASST-06 (send->stream engine) and later phases (Hermes, tool broker, write
//    proposals) are where any future event wiring belongs (e.g. an approvals-bridge notification
//    handler in phase 6) — nothing for phases 0-1's CRUD-only scope to react to yet.
import type { ModuleContract } from "../contract";

export const assistantModule: ModuleContract = {
  key: "assistant",
  migrations: ["0079_module_assistant.sql"],
  permissions: [
    { key: "assistant:thread:read", description: "Read your own assistant threads and messages" },
    { key: "assistant:thread:write", description: "Create, rename, pin, archive or delete your own assistant threads" },
    { key: "assistant:memory:read", description: "Read your own assistant memory (durable facts/preferences)" },
    { key: "assistant:memory:write", description: "Propose, confirm or delete your own assistant memory" },
  ],
  customFieldTargets: [],
  mcpTools: [],
  rollupProviders: [],
  uiManifest: [
    { label: "Assistant", path: "/assistant" },
  ],
};
