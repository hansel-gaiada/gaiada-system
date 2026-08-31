// WSK-15 — the ONLY file in this directory that talks to MinIO. Reuses WSK-07's `StorageAdapter`
// interface/`S3StorageAdapter` implementation directly (`../../storage/s3-storage.adapter.ts` — a
// plain class with no NestJS-DI or vocabulary dependency of its own, so it is safe to construct
// outside a Nest application context here) — per this ticket's brief, no second S3 client is
// written.
// NOTE — resolved via `cjs-interop.mts`'s `namedExport`, not a plain named import: this file's
// dependencies (`../../storage/s3-storage.adapter.ts`, `../../storage/storage.config.ts`,
// `../artifact-keys.ts`) are plain commonjs `.ts` files, and the two loaders that run THIS file
// (`tsx` for real CLI execution, `vitest`/Vite for tests) disagree on how a commonjs module's
// named exports surface to an ESM importer. See `cjs-interop.mts`'s header for the full story —
// a plain `import { X } from "./y"` here would work under one loader and silently resolve `X` to
// `undefined` under the other, with no compile-time error (these files are outside `tsc`'s build
// graph). `test/codegen-generator-crossboundary-imports.spec.ts` exists to pin this.
import type * as S3StorageAdapterNs from "../../storage/s3-storage.adapter";
import type * as StorageConfigNs from "../../storage/storage.config";
import type * as ArtifactKeysNs from "../artifact-keys";
import * as s3StorageAdapterModule from "../../storage/s3-storage.adapter";
import * as storageConfigModule from "../../storage/storage.config";
import * as artifactKeysModule from "../artifact-keys";
import { namedExport } from "./cjs-interop.mts";
import type { LatestContractPointer } from "../contract-manifest.types";
import type { BuiltArtifacts } from "./build-artifacts.mts";

const S3StorageAdapter = namedExport<typeof S3StorageAdapterNs.S3StorageAdapter>(s3StorageAdapterModule, "S3StorageAdapter");
const storageConfig = namedExport<typeof StorageConfigNs.storageConfig>(storageConfigModule, "storageConfig");
const artifactKey = namedExport<typeof ArtifactKeysNs.artifactKey>(artifactKeysModule, "artifactKey");
const latestPointerKey = namedExport<typeof ArtifactKeysNs.latestPointerKey>(artifactKeysModule, "latestPointerKey");

type S3StorageAdapter = InstanceType<typeof S3StorageAdapter>;

export function createGeneratorStorageAdapter(): S3StorageAdapter {
  return new S3StorageAdapter({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    forcePathStyle: storageConfig.forcePathStyle,
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
  });
}

/** `null` when this tenant has never had a successful generation — the correct "first run" state,
 *  not an error. */
export async function readLatestPointer(storage: S3StorageAdapter, tenantSlug: string): Promise<LatestContractPointer | null> {
  const bucket = storageConfig.bucketName("artifacts");
  const key = latestPointerKey(tenantSlug);
  const head = await storage.headObject(bucket, key);
  if (!head) return null;
  const obj = await storage.getObject(bucket, key);
  return JSON.parse(obj.body.toString("utf8")) as LatestContractPointer;
}

/** Uploads the three artifact bodies under an IMMUTABLE `<contractVersion>/` prefix, then
 *  overwrites the mutable `latest.json` pointer LAST — so a reader (ContractReadService, or a
 *  concurrent generator run) never observes a pointer referencing artifacts that have not
 *  finished uploading yet. */
export async function publishArtifacts(
  storage: S3StorageAdapter,
  tenantSlug: string,
  built: BuiltArtifacts,
): Promise<LatestContractPointer> {
  const bucket = storageConfig.bucketName("artifacts");
  await storage.ensureBucket(bucket, { versioning: true, objectLock: true });

  const keys = {
    openapiJson: artifactKey(tenantSlug, built.contractVersion, "openapiJson"),
    sdkTs: artifactKey(tenantSlug, built.contractVersion, "sdkTs"),
    sdkPhp: artifactKey(tenantSlug, built.contractVersion, "sdkPhp"),
    contractMd: artifactKey(tenantSlug, built.contractVersion, "contractMd"),
  };

  await Promise.all([
    storage.putObject(bucket, keys.openapiJson, Buffer.from(built.openapiJson, "utf8"), "application/json"),
    storage.putObject(bucket, keys.sdkTs, Buffer.from(built.sdkTs, "utf8"), "application/typescript"),
    // WSK-34 — application/x-httpd-php is the conventional MIME for a .php source file served as a
    // downloadable artifact (never executed server-side here; this bucket only ever serves bytes).
    storage.putObject(bucket, keys.sdkPhp, Buffer.from(built.sdkPhp, "utf8"), "application/x-httpd-php"),
    storage.putObject(bucket, keys.contractMd, Buffer.from(built.contractMd, "utf8"), "text/markdown"),
  ]);

  const pointer: LatestContractPointer = {
    contractVersion: built.contractVersion,
    vocabularyVersion: built.vocabularyVersion,
    blockLibrary: built.blockLibrary,
    contentHash: built.contentHash,
    generatedAt: new Date().toISOString(),
    artifactKeys: keys,
    hashes: JSON.parse(built.hashManifestJson),
    compositionSnapshot: built.compositionSnapshot,
  };
  await storage.putObject(bucket, latestPointerKey(tenantSlug), Buffer.from(JSON.stringify(pointer, null, 2), "utf8"), "application/json");
  return pointer;
}
