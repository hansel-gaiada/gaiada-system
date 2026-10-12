// M6-P4r-a -- the one composition run-codegen.mts performed inline, extracted so the COMPILED
// bundle (dist/codegen/generator.mjs, see ../../../scripts/build-codegen-bundle.mjs) can export it
// and the later trigger (M6-P4r-b) can call it without re-deriving the sequence:
//   fetch the tenant's composition -> read the previous latest.json pointer -> build the
//   artifacts (version bumped per WSK-14's classifier) -> publish (artifact bodies first, the
//   mutable latest.json pointer LAST).
// No trigger lives here, and no process-level side effect: the caller owns the pg.Pool and the
// storage adapter, and decides what to do with the result (console output, an event, nothing).
import type pg from "pg";
import { fetchTenantComposition, type FetchedTenantComposition } from "./fetch-composition.mts";
import { buildContractArtifacts, type BuiltArtifacts } from "./build-artifacts.mts";
import { readLatestPointer, publishArtifacts, publishBlockLibrary } from "./storage-io.mts";
import { readBakedBlockLibrary } from "./block-library.mts";
import type { createGeneratorStorageAdapter } from "./storage-io.mts";
import type { TenantContractSnapshot } from "../../../../delivery/vocabulary/breaking-change.ts";
import type { LatestContractPointer } from "../contract-manifest.types.ts";

export interface GenerateTenantContractResult {
  fetched: FetchedTenantComposition;
  built: BuiltArtifacts;
  pointer: LatestContractPointer;
}

/** `null` when no active tenant has this slug (the caller decides whether that is an error). */
export async function generateTenantContract(
  pool: pg.Pool,
  storage: ReturnType<typeof createGeneratorStorageAdapter>,
  tenantSlug: string,
): Promise<GenerateTenantContractResult | null> {
  const fetched = await fetchTenantComposition(pool, tenantSlug);
  if (!fetched) return null;

  // M6-P4b0: the block library is the fifth artifact. Uploaded (or verified identical) BEFORE the pointer is
  // written, so a pointer never names an object that is not there; a different sha256 under the same version
  // throws here and fails the run loudly. No baked tarball (dev, tests): nothing is invented, the pointer simply
  // has no blockLibrary key.
  const baked = readBakedBlockLibrary();
  const blockLibrary = baked ? await publishBlockLibrary(storage, baked) : null;

  const previousPointer = await readLatestPointer(storage, tenantSlug);
  const previous = previousPointer
    ? { version: previousPointer.contractVersion, snapshot: previousPointer.compositionSnapshot as TenantContractSnapshot }
    : null;

  const built = await buildContractArtifacts({
    tenantSlug: fetched.tenantSlug,
    defaultLocale: fetched.defaultLocale,
    locales: fetched.locales,
    composition: fetched.composition,
    previous,
    blockLibrary: blockLibrary?.ref,
  });

  const pointer = await publishArtifacts(storage, tenantSlug, built, blockLibrary);
  return { fetched, built, pointer };
}
