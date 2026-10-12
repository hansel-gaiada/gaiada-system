// WSK-15 — orchestrates one deterministic generation: composition -> {openapi.v1.json bytes,
// sdk.d.ts bytes, CONTENT-CONTRACT.md bytes, the per-artifact hash manifest, contentHash}. Pure —
// no I/O of its own (fetch-composition.mts and storage-io.mts own the DB/object-store edges; this file
// only combines their inputs/outputs).
import { VOCABULARY_VERSION } from "../../../../delivery/vocabulary/version.ts";
import type { TenantComposition } from "../../../../delivery/vocabulary/composition.ts";
import { validateTenantComposition } from "../../../../delivery/vocabulary/composition.ts";
import type { TenantContractSnapshot } from "../../../../delivery/vocabulary/breaking-change.ts";
import { buildOpenApiDocument } from "./openapi-builder.mts";
import { renderContentContractMd } from "./content-contract-md.mts";
import { generateTsSdk } from "./sdk-ts.mts";
import { generatePhpSdk } from "./sdk-php.mts";
import { computeNextContractVersion, toContractSnapshot } from "./versioning.mts";
import { stableStringify, sha256Hex } from "./canonical-json.mts";
import type { ArtifactHashManifest, BlockLibraryRef } from "../contract-manifest.types.ts";

export interface BuildArtifactsInput {
  tenantSlug: string;
  defaultLocale: string;
  locales: string[];
  composition: TenantComposition;
  /** `null` = no prior generation exists (or the double-run gate's deliberate baseline mode) —
   *  see `versioning.mts`'s own doc comment for what that means for the resulting version. */
  previous: { version: string; snapshot: TenantContractSnapshot } | null;
  /** M6-P4b0 — the real library ref when the image baked a tarball (generator/block-library.mts).
   *  Omitted: the documented placeholder below, i.e. "no block library available". It is metadata
   *  only and never enters the hash manifest, so it cannot move `contentHash`. */
  blockLibrary?: BlockLibraryRef;
}

export interface BuiltArtifacts {
  openapiJson: string;
  sdkTs: string;
  /** WSK-34 — derived from the same OpenAPI document sdkTs comes from; see sdk-php.mts. */
  sdkPhp: string;
  contractMd: string;
  hashManifestJson: string;
  contentHash: string;
  contractVersion: string;
  vocabularyVersion: string;
  blockLibrary: BlockLibraryRef;
  compositionSnapshot: TenantContractSnapshot;
  /** Why the version landed where it did (from WSK-14's classifier) — surfaced by `run-codegen.mts`
   *  in its console output, never silently swallowed (§05's own "never bare major/minor" doctrine). */
  versionReasons: string[];
}

/** design §06: `blockLibrary` names `@gaiada/webdesk-blocks`. This placeholder is what a run records
 *  when NO tarball is baked (dev, tests, an older image): the pointer then carries no
 *  `artifactKeys.blockLibrary` either, which is the actual "unavailable" signal. With a baked tarball
 *  (M6-P4b0) the real `{package, version, range}` is passed in as `input.blockLibrary`. */
const PLACEHOLDER_BLOCK_LIBRARY: BlockLibraryRef = {
  package: "@gaiada/webdesk-blocks",
  version: "0.0.0-pending-wsk16",
  range: "^0.0.0-pending-wsk16",
};

export async function buildContractArtifacts(input: BuildArtifactsInput): Promise<BuiltArtifacts> {
  const validation = validateTenantComposition(input.composition, { vocabularyVersion: VOCABULARY_VERSION });
  if (!validation.valid) {
    const detail = validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`buildContractArtifacts: tenant "${input.tenantSlug}"'s composition is invalid per WSK-14's validator — ${detail}`);
  }

  const { version: contractVersion, reasons: versionReasons } = computeNextContractVersion(input.previous, input.composition);

  const openApiDoc = buildOpenApiDocument({
    tenantSlug: input.tenantSlug,
    contractVersion,
    vocabularyVersion: VOCABULARY_VERSION,
    defaultLocale: input.defaultLocale,
    locales: input.locales,
    composition: input.composition,
  });

  const openapiJson = stableStringify(openApiDoc);
  const sdkTs = await generateTsSdk(openApiDoc);
  // WSK-34: derived from the SAME already-built openApiDoc sdkTs used above — never a second,
  // independently-composed input, so it cannot drift from the OpenAPI document by construction.
  const sdkPhp = generatePhpSdk(openApiDoc as never);
  const contractMd = renderContentContractMd({
    tenantSlug: input.tenantSlug,
    contractVersion,
    vocabularyVersion: VOCABULARY_VERSION,
    defaultLocale: input.defaultLocale,
    locales: input.locales,
    composition: input.composition,
  });

  const hashes: ArtifactHashManifest = {
    openapiJson: sha256Hex(openapiJson),
    sdkTs: sha256Hex(sdkTs),
    sdkPhp: sha256Hex(sdkPhp),
    contractMd: sha256Hex(contractMd),
  };
  const hashManifestJson = stableStringify(hashes);
  const contentHash = `sha256:${sha256Hex(hashManifestJson)}`;

  return {
    openapiJson,
    sdkTs,
    sdkPhp,
    contractMd,
    hashManifestJson,
    contentHash,
    contractVersion,
    vocabularyVersion: VOCABULARY_VERSION,
    blockLibrary: input.blockLibrary ?? PLACEHOLDER_BLOCK_LIBRARY,
    compositionSnapshot: toContractSnapshot(input.composition),
    versionReasons,
  };
}
