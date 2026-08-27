// WSK-15 — the codegen pipeline's storage-side contract shape (design §06's Zone B "contract
// serving" response, restated as plain data). Deliberately dependency-free: this file is imported
// by BOTH sides of a module-system boundary this ticket has to straddle —
//
//   1. the NestJS control-plane side (contract-read.service.ts, contract.controller.ts) — plain
//      commonjs, compiled by `tsc -p tsconfig.json`, MUST NOT transitively import anything from
//      `webdesk/payload/vocabulary/**` (those files use ESM `.ts`-extension relative imports
//      among themselves — e.g. blocks.ts's `from './primitives.ts'` — which `tsc` under this
//      project's `"module": "commonjs"` setting cannot resolve without `allowImportingTsExtensions`,
//      a flag that itself forces `noEmit: true` and would break `npm run build`);
//   2. the standalone ESM generator (`generator/*.mts`, run via `tsx`, NOT part of the `tsc`
//      build — `.mts` is not matched by tsconfig.json's `"src/**/*.ts"` include glob) — which DOES
//      import the vocabulary package directly, because `tsx`/esbuild resolve explicit `.ts`
//      extensions in specifiers without TypeScript's stricter rule.
//
// Splitting the module graph this way (rather than fighting the two projects' incompatible
// module settings) is this ticket's actual "how do I reuse WSK-06/14's vocabulary code from a
// NestJS commonjs service" answer — see the generator/ directory's own header comment and this
// ticket's final report for the full reasoning.

/** design §06's `artifacts.blockLibrary` shape. WSK-16 (the block-renderer library) has not
 *  shipped yet — every value here is a documented placeholder, never fabricated as if a real
 *  package exists on a registry. Flagged in the ticket report, not hidden. */
export interface BlockLibraryRef {
  package: string;
  version: string;
  range: string;
}

/** The per-artifact sha256 hex digests the `contentHash` is computed over (§05/§06: "a canonical
 *  manifest of per-artifact hashes"). Deliberately excludes any timestamp — this is exactly the
 *  object whose canonical (sorted-key) JSON serialization is hashed to produce `contentHash`, and
 *  the design's determinism AC requires that hash to be stable across two runs of the same input. */
export interface ArtifactHashManifest {
  openapiJson: string;
  sdkTs: string;
  contractMd: string;
}

/** The MinIO object keys (bucket = the platform-internal `artifacts` bucket, WSK-07's
 *  `storageConfig.bucketName("artifacts")`) each artifact body was stored under, tenant-prefixed. */
export interface ArtifactObjectKeys {
  openapiJson: string;
  sdkTs: string;
  contractMd: string;
}

/**
 * The `contracts/<tenantSlug>/latest.json` pointer object — written by the generator
 * (`generator/run-codegen.mts`) after a successful generation, read by `ContractReadService` to
 * answer `GET /control/v1/tenants/:slug/contract`. This is the ONLY piece of durable state the
 * codegen pipeline keeps, and it lives entirely in object storage — deliberately, so this ticket
 * needs no new migration (out of scope per the ticket's hard constraints; schema changes are
 * senior-db/architect territory). `compositionSnapshot` is what lets the NEXT run compute a
 * correct semver bump via WSK-14's `classifyTenantContractChange` without a database table to
 * diff against.
 */
export interface LatestContractPointer {
  /** Tenant contract semver (design §05's second axis — NOT the platform-wide vocabulary version). */
  contractVersion: string;
  vocabularyVersion: string;
  blockLibrary: BlockLibraryRef;
  /** `"sha256:" + hex` — matches design §06's example literal shape. */
  contentHash: string;
  /** ISO-8601. Written fresh every run; deliberately NOT part of any hashed artifact body or of
   *  `ArtifactHashManifest` — see this file's header on why timestamps must stay out of the
   *  determinism-checked surface. */
  generatedAt: string;
  artifactKeys: ArtifactObjectKeys;
  hashes: ArtifactHashManifest;
  /** Opaque to this file — see `generator/types.mts`'s `TenantContractSnapshot` for the real
   *  shape (WSK-14's `breaking-change.ts`). Declared `unknown` here (not imported) to keep this
   *  file vocabulary-free, per the header's whole point. */
  compositionSnapshot: unknown;
}

/** design §06's actual `GET /control/v1/tenants/:slug/contract` success response shape. */
export interface ContractReadResponse {
  version: string;
  vocabularyVersion: string;
  blockLibrary: BlockLibraryRef;
  artifacts: {
    sdkTsUrl: string;
    sdkPhpUrl: null; // P6/WSK-34, per WSK-D11 — never fabricated here.
    openapiUrl: string;
    contractMdUrl: string;
  };
  contentHash: string;
  generatedAt: string;
}
