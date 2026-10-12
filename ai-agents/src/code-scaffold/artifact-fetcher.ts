// WSK-20 — resolves the envelope's `prdArtifact`/`prototypeArtifact` (both
// `pipeline_stages.artifact_ref`, WS11 delivery-pipeline artifacts — see envelope.ts's header) to
// text. A DIFFERENT subsystem from the contract-snapshot artifacts (contract-snapshot-provider.ts):
// those are webdev_contract_snapshots' own files; these are the signed PRD stage and the accepted
// design stage's own recorded output. No hub tool resolves a `pipeline_stages.artifact_ref` today
// either (see hub-client.ts's header) — same named gap, reported once there.
import type { Envelope } from "../agent";
import type { ToolCaller } from "./hub-client";

export interface ArtifactFetcher {
  fetchText(tenantId: string, artifactRef: string): Promise<string>;
}

/** Real adapter — `pipeline.artifacts.get` is this ticket's own proposed tool name (not yet a hub
 *  contract; see this file's header). */
export class HubArtifactFetcher implements ArtifactFetcher {
  constructor(
    private readonly callTool: ToolCaller,
    private readonly envelope: Envelope,
  ) {}

  async fetchText(tenantId: string, artifactRef: string): Promise<string> {
    const raw = await this.callTool("pipeline.artifacts.get", { tenantId, artifactRef }, this.envelope);
    const parsed = JSON.parse(raw) as { content?: string | null; resolvable?: boolean; reason?: string };
    // `pipeline.artifacts.get` answers `resolvable: false` (content null) for a ref that is not stored text, such
    // as a URL, a repo, or a pre-file inline value. That is "cannot fetch", not "empty": reading it as "" would
    // scaffold from an empty PRD and report success (M6-P4b1).
    if (parsed.resolvable === false) {
      throw new Error(`artifact ${artifactRef.slice(0, 80)} is not stored text: ${parsed.reason ?? "unresolvable"}`);
    }
    return parsed.content ?? "";
  }
}

/** Test double. */
export class FakeArtifactFetcher implements ArtifactFetcher {
  constructor(private readonly fixtures: Map<string, string>) {}

  async fetchText(_tenantId: string, artifactRef: string): Promise<string> {
    const hit = this.fixtures.get(artifactRef);
    if (hit === undefined) throw new Error(`no fixture for artifact ref: ${artifactRef}`);
    return hit;
  }
}
