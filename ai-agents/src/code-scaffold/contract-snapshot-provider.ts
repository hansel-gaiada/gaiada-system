// WSK-20 — reads the ONE pinned webdev_contract_snapshots row this run is built against. §06: "the
// scaffolder pins a snapshot id and reads snapshots ONLY" — never a live contract fetch, never the
// mutating `webdev.refreshContract` tool (that would silently move the pin mid-scaffold).
//
// Mirrors `platform-nest/src/modules/webdev-contracts/contract-snapshot.service.ts`'s `SnapshotDto`
// shape (read, not imported — cross-project, see this ticket's hard constraints) so a real adapter's
// JSON parse has a byte-faithful target.
import type { Envelope } from "../agent";
import type { ToolCaller } from "./hub-client";

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

/** Real adapter — see hub-client.ts's header for the two hub tools this depends on that do not exist
 *  yet (`webdev.contracts.get`, `webdev.artifacts.download`). Both names are this ticket's own
 *  proposal for the missing read surface, not a confirmed hub contract — a hub-owning ticket picks
 *  the final names when it registers them. */
export class HubContractSnapshotProvider implements ContractSnapshotProvider {
  constructor(
    private readonly callTool: ToolCaller,
    private readonly envelope: Envelope,
  ) {}

  async getSnapshotArtifacts(tenantId: string, snapshotId: string): Promise<ContractSnapshotArtifacts> {
    const rawMeta = await this.callTool("webdev.contracts.get", { tenantId, snapshotId }, this.envelope);
    const meta = JSON.parse(rawMeta) as ContractSnapshotMeta;

    const [openapiB64, sdkTsB64, contractMd, blocksB64, sdkPhpB64] = await Promise.all([
      this.callTool("webdev.artifacts.download", { tenantId, fileId: meta.artifacts.openapi }, this.envelope),
      this.callTool("webdev.artifacts.download", { tenantId, fileId: meta.artifacts.sdkTs }, this.envelope),
      this.callTool("webdev.artifacts.downloadText", { tenantId, fileId: meta.artifacts.contractMd }, this.envelope),
      this.callTool(
        "webdev.artifacts.downloadBlockLibrary",
        { tenantId, package: meta.artifacts.blockLibrary.package, version: meta.artifacts.blockLibrary.version },
        this.envelope,
      ),
      // WSK-D28 / §08: fetched only when the pointer actually has a `sdkPhp` key (WSK-34; `null` for
      // any pointer written before that ticket, per `ArtifactHashManifest`'s own D-10 placeholder
      // note) — never fabricated, never re-derived. `siteKind: "wp"` is refused loudly by
      // `scaffold.ts` when this comes back null, rather than composing a theme with no SDK.
      meta.artifacts.sdkPhp
        ? this.callTool("webdev.artifacts.download", { tenantId, fileId: meta.artifacts.sdkPhp }, this.envelope)
        : Promise.resolve(null),
    ]);

    return {
      meta,
      openApiDocument: JSON.parse(Buffer.from(openapiB64, "base64").toString("utf8")) as Record<string, unknown>,
      sdkTsTarball: Buffer.from(sdkTsB64, "base64"),
      contractMd,
      blockLibraryTarball: Buffer.from(blocksB64, "base64"),
      sdkPhpSource: sdkPhpB64 ? Buffer.from(sdkPhpB64, "base64").toString("utf8") : null,
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
