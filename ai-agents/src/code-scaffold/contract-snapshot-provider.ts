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
  /** M6-P4b0 - files.id of the block-library tarball. Absent or null on a snapshot mirrored before the
   *  library became the fifth artifact (the mirror writes `null` explicitly from then on). */
  blockLibraryFile?: string | null;
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
  /** The generated TypeScript SDK, UTF-8 text: WebDesk's `sdk.d.ts`, the `openapi-typescript` output
   *  (`paths` / `components`, types only). It was named `sdkTsTarball` and vendored as a `.tgz` until
   *  M6-P4b0, but it never was a tarball. `scaffold.ts` vendors it as a tiny local package
   *  (`vendor/webdesk-sdk/{index.d.ts,package.json}`); nothing here ever executes or imports it (WSK-D6). */
  sdkTsSource: string;
  contractMd: string;
  /** The `@gaiada/webdesk-blocks` tarball's raw bytes (gzip), read from the snapshot's own fifth artifact
   *  (`webdev.contracts.artifact` `{artifact: "blockLibrary"}`, M6-P4b0). `null` when the snapshot has none
   *  (mirrored before M6-P4b0, or WebDesk had no baked library): `scaffold.ts` then refuses an astro or node
   *  site loudly rather than vendoring an empty library. */
  blockLibraryTarball: Buffer | null;
  /** WSK-34's generated PHP SDK source (`sdk.php`, plain UTF-8 text — never a tarball, it is vendored
   *  as a single file per `templates/wp-site.ts`'s `vendoredSdkPhp`).
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
 *  M6-P4b0: the block-library tarball is the snapshot's fifth artifact, read through the same tool. */
export class HubContractSnapshotProvider implements ContractSnapshotProvider {
  constructor(
    private readonly callTool: ToolCaller,
    private readonly envelope: Envelope,
  ) {}

  /** One stored artifact's bytes via `webdev.contracts.artifact` (JSON `{ base64, … }`). */
  private async artifactBytes(
    tenantId: string,
    snapshotId: string,
    artifact: "openapi" | "sdkTs" | "sdkPhp" | "contractMd" | "blockLibrary",
  ): Promise<Buffer> {
    const raw = await this.callTool("webdev.contracts.artifact", { tenantId, snapshotId, artifact }, this.envelope);
    const body = parseToolJson<{ base64?: unknown }>(raw);
    if (typeof body.base64 !== "string") {
      throw new Error(`webdev.contracts.artifact(${artifact}) returned no base64 payload`);
    }
    return Buffer.from(body.base64, "base64");
  }

  /** The block library, or `null` when the snapshot has none: a null pointer (the mirror records
   *  `blockLibraryFile: null`, or an older row has no such key) skips the call, and a `404 artifact_absent`
   *  from the tool (a pointer whose file or object is gone) is the same `null`. Any other failure
   *  (hash mismatch, hub down) propagates: a corrupt tarball must never read as "absent". */
  private async blockLibraryBytes(tenantId: string, snapshotId: string, meta: ContractSnapshotMeta): Promise<Buffer | null> {
    if (!meta.artifacts.blockLibraryFile) return null;
    try {
      return await this.artifactBytes(tenantId, snapshotId, "blockLibrary");
    } catch (err) {
      if (/artifact_absent/.test((err as Error).message)) return null;
      throw err;
    }
  }

  async getSnapshotArtifacts(tenantId: string, snapshotId: string): Promise<ContractSnapshotArtifacts> {
    const rawMeta = await this.callTool("webdev.contracts.get", { tenantId, snapshotId }, this.envelope);
    const meta = parseToolJson<ContractSnapshotMeta>(rawMeta);

    const [openapi, sdkTs, contractMd, blockLibrary, sdkPhp] = await Promise.all([
      this.artifactBytes(tenantId, snapshotId, "openapi"),
      this.artifactBytes(tenantId, snapshotId, "sdkTs"),
      this.artifactBytes(tenantId, snapshotId, "contractMd"),
      this.blockLibraryBytes(tenantId, snapshotId, meta),
      // WSK-D28 / §08: fetched only when the pointer actually has a `sdkPhp` key (WSK-34; `null` for
      // any pointer written before that ticket) — never fabricated, never re-derived. `siteKind: "wp"`
      // is refused loudly by `scaffold.ts` when this comes back null, rather than composing a theme
      // with no SDK.
      meta.artifacts.sdkPhp ? this.artifactBytes(tenantId, snapshotId, "sdkPhp") : Promise.resolve(null),
    ]);

    return {
      meta,
      openApiDocument: JSON.parse(openapi.toString("utf8")) as Record<string, unknown>,
      sdkTsSource: sdkTs.toString("utf8"),
      contractMd: contractMd.toString("utf8"),
      blockLibraryTarball: blockLibrary,
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
