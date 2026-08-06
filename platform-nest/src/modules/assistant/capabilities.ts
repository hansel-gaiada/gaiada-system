// ASST-18 — the capabilities panel's ONE source of truth: `GET :tenantId/assistant/capabilities`.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-18").
// Design: docs/blueprints/assistant-foundation.md §8 (right-rail "capabilities" list + the
// empty-state capability cards that must come from this SAME source, not a hand-maintained list).
//
// ── THE FORMULA, LITERALLY ──────────────────────────────────────────────────────────────────────────
// `visibleToolsFor(user) ∩ tenant's module gates`. The first half is ASST-17's seam, reused
// verbatim (`listUserVisibleToolDefs`, broker.ts) — it asks the hub `tools/list` under the CHATTING
// USER'S OWN OBO envelope (`oboEnvelopeFor`, the one function that can spell one). This file adds
// exactly one more filter on top of that result.
//
// ── WHY "MODULE GATES" MEANS `ModuleContract.mcpTools` OWNERSHIP, NOT THE HUB'S OWN `source` TAG ───
// The hub tags every registered tool with a `source` (`platform-read`/`platform-write`/`pipeline`/
// `delivery`/`pm`/`work-activity`/`core`/`module`) for its OWN admin console — but that tag is not a
// module KEY, and `mcp-hub/src/module-tools.ts`'s own comment says so explicitly: module-contributed
// tools are aggregated from the platform's flat `GET /mcp/tool-defs` union, so (that comment's own
// words) "the owning module key isn't recoverable" from the hub side. The ONLY place a tool name is
// provably attributable to a specific, toggleable module is platform-nest's OWN in-process
// registry: `allModules()[].mcpTools[].name`
// (e.g. `agency.pendingApprovals` really is owned by the `agency` ModuleContract). A tool that
// appears in NO module's `mcpTools` — every `platform-read`/`platform-write`/core tool, including
// the exact three `ASSISTANT_AGENT_TOOLS` (broker.ts) already drives a turn with — is not owned by
// any toggleable module at all, and passes through UNGATED here. Excluding it would be a false
// negative (hiding a capability the user genuinely has), not a safety improvement — the hub +
// Cerbos already decided the user may call it; this file only ever NARROWS that further.
//
// ── FAILS CLOSED, AND SAYS SO HONESTLY (not "zero capabilities" masquerading as "hub is fine") ─────
// `listUserVisibleToolDefs` already fails closed (empty array) on an unreachable/misconfigured hub.
// This file adds no new failure mode — it can only narrow that result further — but it DOES surface
// `hubConfigured` alongside the tool list, so the panel can render an honest "the assistant's tool
// catalogue isn't reachable right now" instead of silently reading "you have zero capabilities" (the
// two are not the same fact, and conflating them would be exactly the "cached or optimistic list"
// failure mode the ticket forbids in the OTHER direction — this is its mirror: don't UNDER-explain a
// hub outage as if it were an authorization decision).
import { allModules, enabledModuleKeys } from "../registry";
import { ASSISTANT_AGENT_TOOLS, ASSISTANT_AGENT_WRITE_TOOLS, listUserVisibleToolDefs, type ChattingUser, type VisibleToolDef } from "./broker";
import { config } from "../../config";

export interface AssistantCapability {
  name: string;
  description: string;
  /** The `ModuleContract.key` that contributed this tool, or `null` when it is an ungated
   *  platform-core tool (see file header). Purely informational — grouping only, never a second
   *  authorization decision (the filtering already happened before this field is attached). */
  module: string | null;
}

/** One tool-using agent the broker (`broker.ts`) can drive a turn through — the AUTHORITATIVE list,
 *  so the FE never hand-maintains its own copy of agent names/tools (ASST-23, §7.4/T3a). */
export interface AssistantToolAgent {
  name: string;
  /** Every tool this agent may call (read + write). Mirrors `ASSISTANT_AGENT_TOOLS[name]`. */
  tools: readonly string[];
  /** The subset of `tools` this agent may PROPOSE as a D14 write (files an approval, never executes
   *  in-process). Mirrors `ASSISTANT_AGENT_WRITE_TOOLS[name]` — `[]` for a read-only agent. */
  writeTools: readonly string[];
}

export interface CapabilitiesResult {
  tools: AssistantCapability[];
  /** `false` means the hub URL/token isn't set in THIS environment at all — the honest "not
   *  configured here" state distinct from "configured, and you have none" (both currently reduce to
   *  the same underlying `[]` in `listUserVisibleToolDefs`; this flag is a best-effort hint the
   *  panel can use to word its empty state without over-claiming precision it doesn't have). */
  hubConfigured: boolean;
  /** Every agent `broker.ts` can drive a tool turn through, plus which of its tools are writes — the
   *  composer's agent picker sources from THIS, not a hand-maintained FE list (ASST-23). Independent
   *  of `tools`/`hubConfigured` above: it is not filtered by what THIS caller can currently see (the
   *  hub/Cerbos still decide that per-turn, twice) — it is simply the broker's own real roster. */
  toolAgents: AssistantToolAgent[];
}

/** `toolName -> owning module key`, rebuilt fresh from the in-process registry on every call. This
 *  is an in-memory map over compiled-in modules (`allModules()`, already resident) — cheap enough
 *  that caching it would only risk staleness across a module (de)registration for no real win. */
function toolModuleMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of allModules()) {
    for (const t of m.mcpTools) map.set(t.name, m.key);
  }
  return map;
}

export interface CapabilitiesOptions {
  fetchImpl?: typeof fetch;
  hubUrl?: string;
  hubToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam — default is the live `listUserVisibleToolDefs` (the real hub call). Never used by
   *  production code; injecting anything else here is exactly how a test could make this endpoint
   *  disagree with the real capability gate, so keep this seam OUT of any non-test call site. */
  visibleToolDefs?: (user: ChattingUser, opts?: CapabilitiesOptions) => Promise<VisibleToolDef[]>;
}

/**
 * `visibleToolsFor(user) ∩ tenant's module gates` — see file header. Every tool in the result is
 * BOTH something the hub says THIS user may call under their own Cerbos principal AND, if it
 * belongs to a toggleable module at all, something that module is currently enabled for
 * `tenantId`. Sorted by name for a stable render (the panel is a list, not a set).
 */
export async function assembleCapabilities(
  user: ChattingUser,
  tenantId: string,
  opts: CapabilitiesOptions = {},
): Promise<CapabilitiesResult> {
  const listDefs = opts.visibleToolDefs ?? listUserVisibleToolDefs;
  const [defs, enabled] = await Promise.all([listDefs(user, opts), enabledModuleKeys(tenantId)]);
  const enabledSet = new Set(enabled);
  const owners = toolModuleMap();

  const tools: AssistantCapability[] = [];
  for (const d of defs) {
    const owner = owners.get(d.name) ?? null;
    if (owner !== null && !enabledSet.has(owner)) continue; // module-gated tool, that module is OFF for this tenant
    tools.push({ name: d.name, description: d.description, module: owner });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const hubUrl = opts.hubUrl ?? config.services.hub.url;
  const hubToken = opts.hubToken ?? config.services.hub.token;
  const toolAgents: AssistantToolAgent[] = Object.entries(ASSISTANT_AGENT_TOOLS).map(([name, agentTools]) => ({
    name,
    tools: agentTools,
    writeTools: ASSISTANT_AGENT_WRITE_TOOLS[name] ?? [],
  }));
  return { tools, hubConfigured: !!(hubUrl && hubToken), toolAgents };
}
