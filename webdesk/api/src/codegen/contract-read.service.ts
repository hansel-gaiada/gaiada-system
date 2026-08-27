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
      const [openapiUrl, sdkTsUrl, sdkPhpUrl, contractMdUrl] = await Promise.all([
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "openapiJson"), ttl),
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "sdkTs"), ttl),
        sdkPhpKey ? this.storage.presignGetObject(bucket, sdkPhpKey, ttl) : Promise.resolve(null),
        this.storage.presignGetObject(bucket, artifactKey(tenantSlug, pointer.contractVersion, "contractMd"), ttl),
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
}
