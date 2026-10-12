// M6-P4r-a -- the ENTRY of the compiled generator bundle (dist/codegen/generator.mjs), built by
// webdesk/api/scripts/build-codegen-bundle.mjs. Everything the api will call later is exported
// here and nowhere else; the dev/CI scripts keep importing the individual .mts files through tsx.
// There is deliberately NO trigger in this file (that is M6-P4r-b): importing it has no side effect.
export { buildContractArtifacts } from "./build-artifacts.mts";
export type { BuildArtifactsInput, BuiltArtifacts } from "./build-artifacts.mts";
export { createGeneratorStorageAdapter, readLatestPointer, publishArtifacts, publishBlockLibrary } from "./storage-io.mts";
export { readBakedBlockLibrary, BlockLibraryHashConflictError } from "./block-library.mts";
export type { BakedBlockLibrary, PublishedBlockLibrary } from "./block-library.mts";
export { fetchTenantComposition } from "./fetch-composition.mts";
export type { FetchedTenantComposition } from "./fetch-composition.mts";
export { generateTenantContract } from "./generate-tenant.mts";
export type { GenerateTenantContractResult } from "./generate-tenant.mts";
export { computeNextContractVersion, toContractSnapshot } from "./versioning.mts";
export { stableStringify, sha256Hex } from "./canonical-json.mts";
export { VOCABULARY_VERSION } from "../../../../delivery/vocabulary/version.ts";
