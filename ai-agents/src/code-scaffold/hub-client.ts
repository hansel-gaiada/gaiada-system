// WSK-20 — the ONE seam this goal uses to reach Zone A: MCP hub tool calls, carrying the run's OBO
// envelope, exactly like every other agent-runner call (ai-agents/CLAUDE.md: "Tools come from the
// MCP hub... There is no direct DB access"; ai-agents/src/deps.ts's `callTool`). This goal never
// opens an HTTP connection to platform-nest itself — that would bypass Cerbos/RLS/OBO the same way a
// direct-DB agent would.
//
// ── A REAL, NAMED GAP (report this) ──────────────────────────────────────────────────────────────
// No hub tool exists today that (a) reads one `webdev_contract_snapshots` row by id (WSK-19 only
// exposes `POST .../contracts/refresh` — which FETCHES A NEW ONE FROM ZONE B, the wrong operation for
// a scaffolder that must read an ALREADY-MIRRORED, already-hashed snapshot — and `GET .../contracts`,
// a recent-200 list with no id filter) or (b) downloads arbitrary file bytes by id
// (`platform-nest/src/core/files.controller.ts`'s `GET :tenantId/files/:fileId/content` has no hub
// tool wrapper), or (c) resolves a `pipeline_stages.artifact_ref` to text (the PRD/prototype are WS11
// delivery-pipeline artifacts, a different subsystem again). `mcp-hub/src/*.ts` registers none of
// these three read tools as of this ticket (grepped: zero `webdev.`/`webdesk.`/`files.` tool
// registrations exist). The three interfaces below (`ToolCaller`, `ContractSnapshotProvider`,
// `ArtifactFetcher`) are this ticket's own seam for that missing plumbing — a HUB-owning ticket must
// register the tool names documented on each Hub* adapter below before a live run can succeed; until
// then this goal is exercised through the `Fake*` test doubles only. This is reported as a blocker in
// the ticket's own final report, not silently worked around with a direct HTTP call.
import type { Envelope } from "../agent";

/** Identical shape to `AgentDeps["callTool"]` (ai-agents/src/agent.ts) — this goal is driven the same
 *  way any other specialist reaches the hub, so a real run wires `liveDeps.callTool` straight through. */
export type ToolCaller = (name: string, args: Record<string, unknown>, envelope: Envelope) => Promise<string>;

/** Thin JSON-RPC-content-text parse, mirroring `deps.ts`'s own `callTool` return convention: every
 *  hub tool call resolves to a text payload the caller `JSON.parse`s itself. */
export function parseToolJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
