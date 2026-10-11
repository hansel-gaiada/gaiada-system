// WSK-20 — reads the ONE pinned webdev_contract_snapshots row this run is built against. §06: "the
// scaffolder pins a snapshot id and reads snapshots ONLY" — never a live contract fetch, never the
// mutating `webdev.refreshContract` tool (that would silently move the pin mid-scaffold).
//
// Mirrors `platform-nest/src/modules/webdev-contracts/contract-snapshot.service.ts`'s `SnapshotDto`
// shape (read, not imported — cross-project, see this ticket's hard constraints) so a real adapter's
// JSON parse has a byte-faithful target.
import type { Envelope } from "../agent";
import { parseToolJson, type ToolCaller } from "./hub-client";

export interface ContractSnapshotArtifactRefs {
  sdkTs: string; // files.id
  sdkPhp: string | null; // null until P6 (D-10)
  openapi: string; // files.id
  contractMd: string; // files.id
  blockLibrary: { package: string; version: string; range: string };
}

export interface ContractSnapshotMeta {
  id: string;
  tenantId: string;
  webdeskTenantSlug: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
  artifacts: ContractSnapshotArtifactRefs;
}

export interface ContractSnapshotArtifacts {
  meta: ContractSnapshotMeta;
  /** Parsed openapi.v1.json — a plain JSON document, never executed (only ever `JSON.parse`d). */
  openApiDocument: Record<string, unknown>;
  /** The SDK tarball's raw bytes, as downloaded — installed by the git-writer as a vendored `.tgz`
   *  file, NEVER unpacked/required/imported by this process (WSK-D6). */
  sdkTsTarball: Buffer;
  contractMd: string;
  /** The pinned `@gaiada/webdesk-blocks@{constraints.blockLibraryVersion}` tarball's raw bytes.
   *  NOT stored on `webdev_contract_snapshots` (its `artifacts.blockLibrary` is only
   *  `{package, version, range}` metadata, per §06's Zone B contract response) — where the ACTUAL
   *  tarball bytes for a pinned block-library version live is undefined anywhere in this rail as of
   *  this ticket (WSK-16 built it as a hand-`npm pack`ed file with no publish/store step). This
   *  field is this ticket's own seam for that missing plumbing, same status as the two hub tools
   *  documented in hub-client.ts's header — reported as a third gap. */
  blockLibraryTarball: Buffer;
  /** WSK-34's generated PHP SDK source (`sdk.php`, plain UTF-8 text — never a tarball, it is vendored
   *  as a single file per `webdesk/wordpress/scaffold-template/wp-site.ts`'s `vendoredSdkPhp`).
   *  `null` when `meta.artifacts.sdkPhp` itself is null (a tenant/contract generated before WSK-34,
   *  or — until webdesk/api's codegen output is actually wired into a live Zone B contract read —
   *  simply not produced yet). `undefined` only for pre-WSK-D28 fixtures that predate this field;
   *  `scaffold.ts`'s `wp` branch must treat BOTH as "no PHP SDK available" and refuse loudly rather
   *  than fabricate one. */
  sdkPhpSource?: string | null;
}

export class SnapshotNotFoundError extends Error {
  constructor(snapshotId: string) {
    super(`contract snapshot not found: ${snapshotId}`);
    this.name = "SnapshotNotFoundError";
  }
}

export interface ContractSnapshotProvider {
  getSnapshotArtifacts(tenantId: string, snapshotId: string): Promise<ContractSnapshotArtifacts>;
}

/** Real adapter. The snapshot read tools are `webdev.contracts.get` and `webdev.contracts.artifact`
 *  (M6-P4a, registered by the webdev module manifest; read-only; the file is resolved server-side from
 *  the snapshot's own pointer and integrity-checked there — this side never supplies a file id).
 *  `webdev.artifacts.downloadBlockLibrary` below is STILL an unregistered placeholder: where the
 *  block-library tarball lives is a separate ticket (M6-P4b), so a live run cannot finish until it lands. */
export class HubContractSnapshotProvider implements ContractSnapshotProvider {
  constructor(
    private readonly callTool: ToolCaller,
    private readonly envelope: Envelope,
  ) {}

  /** One stored artifact's bytes via `webdev.contracts.artifact` (JSON `{ base64, … }`). */
  private async artifactBytes(
    tenantId: string,
    snapshotId: string,
    artifact: "openapi" | "sdkTs" | "sdkPhp" | "contractMd",
  ): Promise<Buffer> {
    const raw = await this.callTool("webdev.contracts.artifact", { tenantId, snapshotId, artifact }, this.envelope);
    const body = parseToolJson<{ base64?: unknown }>(raw);
    if (typeof body.base64 !== "string") {
      throw new Error(`webdev.contracts.artifact(${artifact}) returned no base64 payload`);
    }
    return Buffer.from(body.base64, "base64");
  }

  async getSnapshotArtifacts(tenantId: string, snapshotId: string): Promise<ContractSnapshotArtifacts> {
    const rawMeta = await this.callTool("webdev.contracts.get", { tenantId, snapshotId }, this.envelope);
    const meta = parseToolJson<ContractSnapshotMeta>(rawMeta);

    const [openapi, sdkTs, contractMd, blocksB64, sdkPhp] = await Promise.all([
      this.artifactBytes(tenantId, snapshotId, "openapi"),
      this.artifactBytes(tenantId, snapshotId, "sdkTs"),
      this.artifactBytes(tenantId, snapshotId, "contractMd"),
      // M6-P4b (separate ticket): the block-library tarball source is not defined yet; this tool name
      // is still the old placeholder and is NOT registered on the hub.
      this.callTool(
        "webdev.artifacts.downloadBlockLibrary",
        { tenantId, package: meta.artifacts.blockLibrary.package, version: meta.artifacts.blockLibrary.version },
        this.envelope,
      ),
      // WSK-D28 / §08: fetched only when the pointer actually has a `sdkPhp` key (WSK-34; `null` for
      // any pointer written before that ticket) — never fabricated, never re-derived. `siteKind: "wp"`
      // is refused loudly by `scaffold.ts` when this comes back null, rather than composing a theme
      // with no SDK.
      meta.artifacts.sdkPhp ? this.artifactBytes(tenantId, snapshotId, "sdkPhp") : Promise.resolve(null),
    ]);

    return {
      meta,
      openApiDocument: JSON.parse(openapi.toString("utf8")) as Record<string, unknown>,
      sdkTsTarball: sdkTs,
      contractMd: contractMd.toString("utf8"),
      blockLibraryTarball: Buffer.from(blocksB64, "base64"),
      sdkPhpSource: sdkPhp ? sdkPhp.toString("utf8") : null,
    };
  }
}

/** Test double — an in-memory fixture set, keyed by snapshotId. Exercises every downstream file
 *  (page-composer, contract-lock, git-writer, scaffold) without any hub/network dependency. */
export class FakeContractSnapshotProvider implements ContractSnapshotProvider {
  constructor(private readonly fixtures: Map<string, ContractSnapshotArtifacts>) {}

  static withOne(artifacts: ContractSnapshotArtifacts): FakeContractSnapshotProvider {
    return new FakeContractSnapshotProvider(new Map([[artifacts.meta.id, artifacts]]));
  }

  async getSnapshotArtifacts(_tenantId: string, snapshotId: string): Promise<ContractSnapshotArtifacts> {
    const hit = this.fixtures.get(snapshotId);
    if (!hit) throw new SnapshotNotFoundError(snapshotId);
    return hit;
  }
}
