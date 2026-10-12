// WSK-15 — reads the codegen pipeline's output for `GET /control/v1/tenants/:slug/contract`
// (design §06). Deliberately does NOT regenerate anything on request: §06 says codegen runs
// "every applySchema (and every vocabulary release reaching the tenant)" — a request-time
// generation would be slow, non-idempotent under concurrent readers, and would defeat the whole
// point of a content-addressed, immutable artifact store. This service only ever reads the
// `contracts/<tenantSlug>/latest.json` pointer the generator (`generator/run-codegen.mts`) wrote,
// and mints short-lived pre-signed GET URLs for the artifacts it names.
//
// Commonjs-safe by construction (no `.ts`-extension imports, no vocabulary import) — see
// `contract-manifest.types.ts`'s header for why that matters here.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { STORAGE_ADAPTER } from "../storage/storage.tokens";
import type { StorageAdapter } from "../storage/storage.types";
import { storageConfig } from "../storage/storage.config";
import { latestPointerKey, artifactKey } from "./artifact-keys";
import type { ContractReadResponse, LatestContractPointer } from "./contract-manifest.types";

/** Exactly 64 lowercase hex characters (a sha256 digest as `createHash(...).digest("hex")` writes it). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** M6-P4j (WSK-D81) -- the five artifacts `readArtifact` serves over the control channel, named as the
 *  ERP asks for them (the route's `:artifact` segment). `openapi` is the storage layer's `openapiJson`. */
export const CONTRACT_ARTIFACT_NAMES = ["openapi", "sdkTs", "sdkPhp", "contractMd", "blockLibrary"] as const;
export type ContractArtifactName = (typeof CONTRACT_ARTIFACT_NAMES)[number];

export function isContractArtifactName(value: string): value is ContractArtifactName {
  return (CONTRACT_ARTIFACT_NAMES as readonly string[]).includes(value);
}

/** The largest artifact the control channel will carry (the tgz is the big one, a few MiB today). */
export const MAX_CONTRACT_ARTIFACT_BYTES = 25 * 1024 * 1024;

/** An artifact exists but is over `MAX_CONTRACT_ARTIFACT_BYTES`; the controller maps it to a 5xx. */
export class ContractArtifactTooLargeError extends Error {
  constructor(readonly artifact: ContractArtifactName, readonly bytes: number) {
    super(`contract artifact '${artifact}' is ${bytes} bytes, over the ${MAX_CONTRACT_ARTIFACT_BYTES}-byte control-channel cap`);
    this.name = "ContractArtifactTooLargeError";
  }
}

export interface ContractArtifactBody {
  body: Buffer;
  contentType: string;
}

const ARTIFACT_CONTENT_TYPES: Record<ContractArtifactName, string> = {
  openapi: "application/json",
  sdkTs: "application/octet-stream",
  sdkPhp: "application/octet-stream",
  contractMd: "text/markdown; charset=utf-8",
  blockLibrary: "application/gzip",
};

/** A contract version is plain semver (`1.0.0`, `2.1.0-rc.1`). Anything else cannot name a stored version and is
 *  never interpolated into an object key. */
const CONTRACT_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;

@Injectable()
export class ContractReadService {
  private readonly logger = new Logger(ContractReadService.name);

  constructor(@Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter) {}

  /** Null when no contract has ever been generated for this tenant — a distinct, more honest
   *  state than "not implemented" now that WSK-15 exists (the controller maps this to a 404, not
   *  the old blanket 501).
   *
   *  Wrapped in a top-level try/catch, on purpose: `StorageAdapter.headObject`'s NotFound
   *  detection (WSK-07's `s3-storage.adapter.ts`, not this ticket's file to edit) recognizes an
   *  absent OBJECT (`NotFound`/`NoSuchKey`/404) but not every provider's shape for an absent
   *  BUCKET — a real throwaway/dev stack whose `artifacts` bucket was never bootstrapped throws an
   *  unrecognized SDK error there instead of returning `null` (caught live, WSK-22's own
   *  `control-jobs.spec.ts` run against a storage-less throwaway stack: an unhandled
   *  `@aws-sdk/middleware-sdk-s3` error turned this route into a bare 500 instead of the
   *  documented 404). From this endpoint's caller's point of view "no contract" and "the artifact
   *  store cannot currently answer" are the same actionable fact (nothing to serve right now) —
   *  any storage-layer failure here degrades to the SAME null/404 outcome, logged loudly so an
   *  operator can tell the two cases apart from the logs, never from the response shape. */
  async readLatest(tenantSlug: string): Promise<ContractReadResponse | null> {
    const bucket = storageConfig.bucketName("artifacts");
    const pointerKey = latestPointerKey(tenantSlug);

    let pointer: LatestContractPointer;
    try {
      const head = await this.storage.headObject(bucket, pointerKey);
      if (!head) return null;

      const obj = await this.storage.getObject(bucket, pointerKey);
      pointer = JSON.parse(obj.body.toString("utf8")) as LatestContractPointer;
    } catch (err) {
      this.logger.error(`could not read latest.json for tenant '${tenantSlug}' (treating as no contract generated): ${String(err)}`);
      return null;
    }

    try {
      const ttl = storageConfig.presignedGetTtlSeconds;
      // WSK-34 — `pointer.artifactKeys.sdkPhp` is `undefined` for any `latest.json` written before
      // this ticket (an old pointer object literally has no such property; JSON never invents one).
      // Presigning is skipped in that case rather than presigning a key that was never uploaded —
      // the honest "no PHP SDK for this generation" state stays `null`, never a broken URL.
      const sdkPhpKey = pointer.artifactKeys.sdkPhp as string | undefined;
      // M6-P4b0 — same rule for the block library: an absent key is `null`, never a guessed URL.
      const blockLibraryKey = pointer.artifactKeys.blockLibrary as string | undefined;
      // M6-P4b0b — the tarball's sha256, for the ERP to check what it downloads. Only ever the pointer's own value,
      // and only when a tarball is named and the value is well-formed; anything else is `null`, never a guess.
      const blockLibrarySha256 =
        blockLibraryKey && typeof pointer.blockLibrarySha256 === "string" && SHA256_HEX_RE.test(pointer.blockLibrarySha256)
          ? pointer.blockLibrarySha256
          : null;
      const [openapiUrl, sdkTsUrl, sdkPhpUrl, contractMdUrl, blockLibraryUrl] = await Promise.all([
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "openapiJson"), ttl),
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "sdkTs"), ttl),
        sdkPhpKey ? this.storage.presignGetObject(bucket, sdkPhpKey, ttl) : Promise.resolve(null),
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "contractMd"), ttl),
        blockLibraryKey ? this.storage.presignGetObject(bucket, blockLibraryKey, ttl) : Promise.resolve(null),
      ]);

      return {
        version: pointer.contractVersion,
        vocabularyVersion: pointer.vocabularyVersion,
        blockLibrary: pointer.blockLibrary,
        artifacts: {
          sdkTsUrl,
          sdkPhpUrl,
          openapiUrl,
          contractMdUrl,
          blockLibraryUrl,
          blockLibrarySha256,
        },
        contentHash: pointer.contentHash,
        generatedAt: pointer.generatedAt,
      };
    } catch (err) {
      // A readable pointer but a presign failure means the artifact store is reachable but
      // misbehaving for this specific request — still "cannot currently serve a contract", never
      // a fabricated URL.
      this.logger.error(`could not presign artifact URLs for tenant '${tenantSlug}' contract ${pointer.contractVersion}: ${String(err)}`);
      return null;
    }
  }

  /** M6-P4j (WSK-D81) -- the raw bytes of one artifact of one stored contract version: how the ERP gets them, since
   *  the presigned URLs `readLatest` returns name this estate's internal object store and cross no boundary.
   *  Resolves the key exactly as `readLatest` does (`artifactKey`; the block library's key from the pointer, which
   *  only describes the latest version, so an older version has none).
   *
   *  `null` when the version is not a stored version of THIS tenant, or the artifact is absent for it (sdkPhp and
   *  blockLibrary legitimately are for older generations). Throws `ContractArtifactTooLargeError` over the cap;
   *  a storage failure propagates (unlike `readLatest` there is no honest "nothing to serve" reading of it). */
  async readArtifact(tenantSlug: string, contractVersion: string, artifact: ContractArtifactName): Promise<ContractArtifactBody | null> {
    if (!CONTRACT_VERSION_RE.test(contractVersion)) return null;
    const bucket = storageConfig.bucketName("artifacts");

    let key: string | undefined;
    if (artifact === "blockLibrary") {
      const pointerKey = latestPointerKey(tenantSlug);
      if (!(await this.storage.headObject(bucket, pointerKey))) return null;
      const pointer = JSON.parse((await this.storage.getObject(bucket, pointerKey)).body.toString("utf8")) as LatestContractPointer;
      if (pointer.contractVersion !== contractVersion) return null;
      key = pointer.artifactKeys.blockLibrary as string | undefined;
    } else {
      key = artifactKey(tenantSlug, contractVersion, artifact === "openapi" ? "openapiJson" : artifact);
    }
    if (!key) return null;

    const head = await this.storage.headObject(bucket, key);
    if (!head) return null;
    if (typeof head.contentLength === "number" && head.contentLength > MAX_CONTRACT_ARTIFACT_BYTES) {
      throw new ContractArtifactTooLargeError(artifact, head.contentLength);
    }
    const obj = await this.storage.getObject(bucket, key);
    if (obj.body.length > MAX_CONTRACT_ARTIFACT_BYTES) throw new ContractArtifactTooLargeError(artifact, obj.body.length);
    return { body: obj.body, contentType: ARTIFACT_CONTENT_TYPES[artifact] };
  }
}
