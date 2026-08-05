// Assistant module contract (ASST-05). Routes live in AssistantController; this object carries
// the registry/rollup metadata (migrations, permissions, customFieldTargets, mcpTools,
// rollupProviders, uiManifest, eventHandlers) that the engine + registry + hub tool-def
// aggregation consume — same split as hrModule/pmModule (see modules/hr/index.ts).
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-05").
// Design: docs/blueprints/assistant-foundation.md §4 (data model), §6 (authorization).
//
// ── LEFT DELIBERATELY EMPTY (do not fill with a placeholder — see each reason) ───────────────────
//  - `mcpTools`: STILL EMPTY AFTER ASST-17 (the Phase-3 tool broker), and that is the correct end
//    state, not a leftover. `mcpTools` is what a module CONTRIBUTES to the hub's catalogue
//    (aggregated by `GET /mcp/tool-defs`); the assistant is a tool CONSUMER — `modules/assistant/
//    broker.ts` calls the hub's existing catalogue under the chatting user's OBO envelope and owns
//    no tool of its own. Registering something here would advertise a tool this module has no
//    authorized execution path behind, which is the same "advertise what you cannot serve" hazard
//    the original note warned about.
//  - `rollupProviders`: no metric surface is specified for the assistant in blueprint phases 0-1;
//    a future ticket can add one (e.g. thread/message counts) if a department dashboard wants it.
//    Registering an empty-metric provider now would just be dead weight in syncMetricDefinitions().
//  - `customFieldTargets`: threads/messages/memory have no custom-field surface in the design.
//  - `eventHandlers`: still nothing to react to. ASST-17's write half is a PROPOSAL that surfaces as
//    `approval_required` on the live stream and a `pending` `assistant_tool_calls` row — it is
//    consumed synchronously, not via the event backbone. A handler would only become useful once a
//    D14 decision needs to reach a thread the user is no longer watching (phase 6).
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
