// M6-P4b0 -- the block-renderer library (@gaiada/webdesk-blocks) as the fifth contract artifact.
//
// WHAT THIS FILE OWNS
//   1. Finding the tarball the api image baked (webdesk/api/Dockerfile, stage `blocks`):
//        <dir>/gaiada-webdesk-blocks-<version>.tgz   and   <dir>/SHA256SUMS
//      <dir> defaults to /app/artifacts/blocks and can be moved with WEBDESK_BLOCKS_ARTIFACT_DIR.
//   2. The UPLOAD RULE: one shared, CONTENT-ADDRESSED object per tarball in the `artifacts` bucket,
//        blocks/<version>/<sha16>/gaiada-webdesk-blocks-<version>.tgz        (the tarball)
//        blocks/<version>/<sha16>/gaiada-webdesk-blocks-<version>.tgz.sha256 (a sidecar: the hex digest + "\n")
//      - tarball absent                   -> upload it, then the sidecar
//      - present, same sha256             -> do nothing
//      - present, DIFFERENT sha256        -> throw BlockLibraryHashConflictError (a damaged object, or a
//        16-hex prefix collision). Never overwrite: the bucket is object-locked (GOVERNANCE).
//      A blocks change shipped WITHOUT a version bump gets its own key (M6 review, 2026-10-12); under a
//      version-only key it would have failed every tenant's codegen at run time until someone bumped it.
//
// WHERE THE VERSION AND THE HASH COME FROM
//   version  the FILENAME of the baked tarball (npm pack names it <name>-<version>.tgz and the
//            Dockerfile verifies BLOCKS_VERSION against package.json before baking). No manifest file
//            exists in the image, and reading the version out of the tgz would need a tar reader.
//   sha256   computed here over the tarball's own bytes, and required to AGREE with the baked
//            SHA256SUMS line for that file (a disagreement means the image layer is damaged: refuse).
//
// WHY A SIDECAR, NOT OBJECT METADATA
//   StorageAdapter (src/storage/storage.types.ts) is a deliberately provider-neutral seam with no
//   user-metadata channel; widening it for one caller would touch every adapter. A sidecar object
//   needs only putObject/getObject. A tarball without a sidecar (a run that died between the two
//   puts) is repaired by hashing the stored tarball itself, so the pair can never wedge.
//
// DETERMINISM
//   The tarball's bytes and sha256 are INPUTS to a codegen run, never timestamps. The hash is kept
//   OUT of ArtifactHashManifest (and so out of `contentHash`): adding a key there would change the
//   contentHash of every already-recorded contract version.
//
// No NestJS, no pg, no vocabulary import: node builtins only, so the bundle step inlines it as is.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlockLibraryRef } from "../contract-manifest.types.ts";

export const BLOCK_LIBRARY_PACKAGE = "@gaiada/webdesk-blocks";
export const DEFAULT_BLOCKS_ARTIFACT_DIR = "/app/artifacts/blocks";
export const BLOCKS_ARTIFACT_DIR_ENV = "WEBDESK_BLOCKS_ARTIFACT_DIR";

const TARBALL_RE = /^gaiada-webdesk-blocks-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The tarball the image baked, read and verified. */
export interface BakedBlockLibrary {
  version: string;
  filename: string;
  sha256: string;
  bytes: Buffer;
  ref: BlockLibraryRef;
}

/** What a codegen run records in the pointer once the tarball is safely in the bucket. */
export interface PublishedBlockLibrary {
  ref: BlockLibraryRef;
  /** The shared object key, `blocks/<version>/<filename>`. */
  key: string;
  sha256: string;
  /** `uploaded`: this run put it there. `unchanged`: it was already there with the same sha256. */
  status: "uploaded" | "unchanged";
}

export class BlockLibraryHashConflictError extends Error {
  constructor(public readonly key: string, public readonly storedSha256: string, public readonly bakedSha256: string) {
    super(
      `block library ${key} is already stored with sha256 ${storedSha256}, but this image baked a tarball with sha256 ${bakedSha256}. ` +
        `Refusing to overwrite (the artifacts bucket is object-locked). The key is content-addressed, so this means ` +
        `two different tarballs share a 16-hex sha256 prefix, or the stored object is damaged; investigate, never overwrite.`,
    );
    this.name = "BlockLibraryHashConflictError";
  }
}

export function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Content-addressed: `blocks/<version>/<sha256 prefix>/…`. A blocks change shipped WITHOUT a version bump
 *  (easy to forget) gets its own key instead of colliding with the stored tarball and failing every
 *  tenant's codegen at run time. Sites pin the exact bytes through their contract snapshot, not the
 *  version range, so nothing reads the version alone. */
export function blockLibraryObjectKey(version: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error(`block library: not a sha256: ${sha256}`);
  return `blocks/${version}/${sha256.slice(0, 16)}/gaiada-webdesk-blocks-${version}.tgz`;
}

export function blockLibraryChecksumKey(version: string, sha256: string): string {
  return `${blockLibraryObjectKey(version, sha256)}.sha256`;
}

export function resolveBlocksArtifactDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env[BLOCKS_ARTIFACT_DIR_ENV]?.trim();
  return v ? v : DEFAULT_BLOCKS_ARTIFACT_DIR;
}

/** The sha256 SHA256SUMS records for `filename` (`sha256sum` format: `<hex>  <name>` or `<hex> *<name>`). */
function checksumFor(sums: string, filename: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Reads the baked tarball. `null` when there is none (a dev box, a test, an image built before M6-P4r-a):
 * the caller then records the library as unavailable. A tarball that IS there but cannot be trusted
 * (two tarballs, no/contradicting SHA256SUMS) throws: a half-baked image must not publish a guess.
 */
export function readBakedBlockLibrary(dir: string = resolveBlocksArtifactDir()): BakedBlockLibrary | null {
  if (!existsSync(dir)) return null;
  const tarballs = readdirSync(dir).filter((f) => TARBALL_RE.test(f)).sort();
  if (tarballs.length === 0) return null;
  if (tarballs.length > 1) {
    throw new Error(`block library: ${dir} holds ${tarballs.length} tarballs (${tarballs.join(", ")}); the image must bake exactly one`);
  }
  const filename = tarballs[0];
  const version = TARBALL_RE.exec(filename)![1];
  const sumsPath = join(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) {
    throw new Error(`block library: ${filename} is baked without ${sumsPath}; refusing to publish an unverified tarball`);
  }
  const expected = checksumFor(readFileSync(sumsPath, "utf8"), filename);
  if (!expected) throw new Error(`block library: ${sumsPath} has no sha256 line for ${filename}`);
  const bytes = readFileSync(join(dir, filename));
  const sha256 = sha256OfBytes(bytes);
  if (sha256 !== expected) {
    throw new Error(`block library: ${filename} hashes to ${sha256} but SHA256SUMS says ${expected}; the baked layer is damaged`);
  }
  return { version, filename, sha256, bytes, ref: { package: BLOCK_LIBRARY_PACKAGE, version, range: `^${version}` } };
}

/** The four storage calls the upload rule needs (a subset of StorageAdapter, so a spec can fake it). */
export interface BlockLibraryStorage {
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<unknown>;
  getObject(bucket: string, key: string): Promise<{ body: Buffer }>;
  headObject(bucket: string, key: string): Promise<unknown>;
}

/** The upload rule (see the file header). The bucket is created by the caller (storage-io.mts). */
export async function ensureBlockLibraryUploaded(
  storage: BlockLibraryStorage,
  bucket: string,
  baked: BakedBlockLibrary,
): Promise<PublishedBlockLibrary> {
  const key = blockLibraryObjectKey(baked.version, baked.sha256);
  const sidecarKey = blockLibraryChecksumKey(baked.version, baked.sha256);
  const published = (status: PublishedBlockLibrary["status"]): PublishedBlockLibrary => ({
    ref: baked.ref,
    key,
    sha256: baked.sha256,
    status,
  });

  const present = await storage.headObject(bucket, key);
  if (!present) {
    // Tarball first, sidecar second: a pointer is never written for an object that is not there, and a crash
    // between the two puts leaves a tarball with no sidecar, which the branch below repairs.
    await storage.putObject(bucket, key, baked.bytes, "application/gzip");
    await storage.putObject(bucket, sidecarKey, Buffer.from(`${baked.sha256}\n`, "utf8"), "text/plain");
    return published("uploaded");
  }

  let stored: string | null = null;
  if (await storage.headObject(bucket, sidecarKey)) {
    const text = (await storage.getObject(bucket, sidecarKey)).body.toString("utf8").trim().toLowerCase();
    if (SHA256_RE.test(text)) stored = text;
  }
  if (stored === null) {
    // No (usable) sidecar: the tarball itself is the authority.
    stored = sha256OfBytes((await storage.getObject(bucket, key)).body);
    if (stored === baked.sha256) {
      await storage.putObject(bucket, sidecarKey, Buffer.from(`${baked.sha256}\n`, "utf8"), "text/plain");
    }
  }
  if (stored !== baked.sha256) throw new BlockLibraryHashConflictError(key, stored, baked.sha256);
  return published("unchanged");
}
