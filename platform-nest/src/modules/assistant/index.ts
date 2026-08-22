// Assistant module contract (ASST-05). Routes live in AssistantController; this object carries
// the registry/rollup metadata (migrations, permissions, customFieldTargets, mcpTools,
// rollupProviders, uiManifest, eventHandlers) that the engine + registry + hub tool-def
// aggregation consume — same split as hrModule/pmModule (see modules/hr/index.ts).
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-05").
// Design: docs/blueprints/assistant-foundation.md §4 (data model), §6 (authorization).
//
// ── LEFT DELIBERATELY EMPTY (do not fill with a placeholder — see each reason) ───────────────────
//  - `mcpTools`: EMPTY UNTIL 2026-08-22, and the reason it was empty is worth keeping. This module is
//    primarily a tool CONSUMER — `broker.ts` calls the hub's existing catalogue under the chatting
//    user's OBO envelope — so registering anything here would have advertised a tool with no
//    authorized execution path behind it: the "advertise what you cannot serve" hazard.
//    `orchestrator.ask` is registered now ONLY because that path was built first
//    (`POST :tenantId/assistant/ask`, the synchronous ask/answer surface). The order mattered: the
//    tool exists because the endpoint does, not the other way round. Everything else below stays
//    empty for its own stated reason.
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
  migrations: ["0079_module_assistant.sql", "0084_assistant_handoffs.sql"],
  // IAM-01d migration: all 5 declared keys are RELATIONSHIP (§7 of docs/superpowers/plans/
  // 2026-08-10-permission-catalog.md) — they map ONLY to the catalog's 15 bypass-exempt pairs
  // (assistant_thread.*, assistant_memory.*, agent_run.read; Ruling 3). A chat thread is a
  // transcript the chatting user owns; widening it to any role-grantable permission — even one
  // this module declares for itself — is exactly the "admin grant becomes a transcript-reading
  // backdoor" hazard `resource_assistant_thread.yaml`'s own header warns against, and one of the 7
  // boot-blockers IAM-01d's fail-closed validation would refuse to start on if these stayed
  // colon-style (or were re-declared dotted). REMOVED, not renamed: these permissions are real and
  // enforced (via `owns` + `inTenant` + `notLow` in Cerbos, never via `permissions`/
  // `role_permissions`), just never role-grantable, so they have no place in a module's grantable
  // permission declarations.
  permissions: [],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "orchestrator.ask",
      description:
        "Ask the ERP assistant a question and get an answer synchronously. Creates (or continues) a " +
        "real assistant thread, so the question, answer, token spend and serving provider are as " +
        "reviewable afterwards as a human's chat turn.",
      // `verified`, not `low`: this spends model budget and writes a thread. An unverified envelope
      // (an unrecognised WhatsApp number, say) has no business opening one.
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/assistant/ask",
      write: true,
      // ⚠ IMPACT: `low`, and this is a judgement worth stating rather than burying.
      //
      // It IS a write (a thread, two messages, token spend), so it is flagged as one — an unflagged
      // mutation escapes the D14 gate entirely, which impact-registry.test.ts fails the build over.
      //
      // But `medium` would suspend EVERY ask for a human decision, which makes the tool useless for
      // its purpose: an agent that must get approval before asking a question cannot use the answer
      // to decide anything. The spend guard for this already exists and is not D14's — the AI gateway
      // is the only key-holder and enforces daily + per-tenant caps. Per-PRINCIPAL budgets remain
      // deferred (plan, alongside Hermes-first routing), so the honest position is: gateway caps
      // bound the cost, the gate bounds the consequence, and asking a question has no consequence to
      // suspend. Revisit if per-principal budgets land or if a persona can spend without a ceiling.
      impact: "low",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          question: { type: "string", description: "The question to ask. Required." },
          threadId: {
            type: "string",
            description: "Continue an existing thread instead of opening one — pass the threadId a previous ask returned.",
          },
          title: { type: "string", description: "Optional title for a new thread; defaults to the question's first 120 chars." },
        },
        required: ["tenantId", "question"],
      },
    },
  ],
  rollupProviders: [],
  uiManifest: [
    { label: "Assistant", path: "/assistant" },
  ],
};
