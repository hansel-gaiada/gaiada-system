// WSK-20 — the ONE seam this goal uses to reach Zone A: MCP hub tool calls, carrying the run's OBO
// envelope, exactly like every other agent-runner call (ai-agents/CLAUDE.md: "Tools come from the
// MCP hub... There is no direct DB access"; ai-agents/src/deps.ts's `callTool`). This goal never
// opens an HTTP connection to platform-nest itself — that would bypass Cerbos/RLS/OBO the same way a
// direct-DB agent would.
//
// ── WHAT EXISTS AND WHAT IS STILL OPEN (updated M6-P4a) ────────────────────────────────────────
// CLOSED (M6-P4a): reading ONE already-mirrored `webdev_contract_snapshots` row and its stored files by
// id. platform-nest serves `GET .../modules/webdev/contracts/:snapshotId` and
// `.../contracts/:snapshotId/artifacts/:artifact`, and the webdev module manifest registers them as the
// read-only hub tools `webdev.contracts.get` and `webdev.contracts.artifact` (the latter resolves the file
// from the snapshot's own pointer and verifies its sha256; `wf:delivery` is allow-listed for both).
// `HubContractSnapshotProvider` calls exactly those two.
//
// CLOSED (M6-P4b0): the pinned `@gaiada/webdesk-blocks` tarball is the snapshot's fifth artifact, read with
// `webdev.contracts.artifact` `{artifact: "blockLibrary"}` (`artifacts.blockLibrary` stays the `{package, version,
// range}` ref; the file id is `artifacts.blockLibraryFile`).
//
// STILL OPEN: (b) arbitrary file
// bytes by id are deliberately NOT exposed (`files.controller.ts`'s `GET :tenantId/files/:fileId/content`
// has no hub wrapper, and the snapshot artifact route is intentionally not a general file reader);
// (c) `pipeline_stages.artifact_ref` text is served by `pipeline.artifacts.get` (see artifact-fetcher.ts).
// The interfaces below (`ToolCaller`, `ContractSnapshotProvider`, `ArtifactFetcher`) remain the seam. This goal never opens an HTTP connection to platform-nest itself.
import type { Envelope } from "../agent";

/** Identical shape to `AgentDeps["callTool"]` (ai-agents/src/agent.ts) — this goal is driven the same
 *  way any other specialist reaches the hub, so a real run wires `liveDeps.callTool` straight through. */
export type ToolCaller = (name: string, args: Record<string, unknown>, envelope: Envelope) => Promise<string>;

/** Thin JSON-RPC-content-text parse, mirroring `deps.ts`'s own `callTool` return convention: every
 *  hub tool call resolves to a text payload the caller `JSON.parse`s itself. */
export function parseToolJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
