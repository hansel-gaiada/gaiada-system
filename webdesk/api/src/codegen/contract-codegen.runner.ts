// M6-P4r-b -- the production ContractCodegenRunner: loads the COMPILED generator bundle
// (dist/codegen/generator.mjs, built by scripts/build-codegen-bundle.mjs as part of `npm run build`)
// and calls its `generateTenantContract(pool, storage, slug)` with the api's own pool and the
// generator's own storage adapter (built from the same STORAGE_* variables, i.e. the api's
// least-privilege `webdesk-api` key: no new credential appears anywhere).
//
// WHY A NATIVE-IMPORT WRAPPER. The bundle is ESM and this file compiles to CommonJS; tsc turns a plain
// `import()` into `require()`, which cannot load an ES module. `new Function` keeps the dynamic import
// native. The path is built from this file's own location and an optional override, never from a job or
// a request, so there is nothing for the Function constructor to be fed from outside.
//
// OUTPUT GOES ONLY TO RUSTFS. The generator never touches the local filesystem (the api container's
// root filesystem is read-only and /tmp is a 64 MiB tmpfs): every artifact is a PUT to the `artifacts`
// bucket, the mutable latest.json pointer last.
import { Inject, Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DbService } from "../db/db.service";
import type { ContractCodegenRunResult, ContractCodegenRunner } from "./contract-codegen.types";

/** The slice of the bundle's export surface this runner uses (bundle-entry.mts is the source of truth). */
interface GeneratorBundle {
  createGeneratorStorageAdapter(): unknown;
  fetchTenantComposition(pool: unknown, tenantSlug: string): Promise<{ composition: unknown } | null>;
  readLatestPointer(storage: unknown, tenantSlug: string): Promise<StoredPointer | null>;
  generateTenantContract(
    pool: unknown,
    storage: unknown,
    tenantSlug: string,
  ): Promise<{ built: { contractVersion: string; contentHash: string } } | null>;
  /** M6-P4b0: the tarball the image baked (verified), or null when none; read from the image directory on every call. */
  readBakedBlockLibrary(): { sha256: string } | null;
  toContractSnapshot(composition: unknown): unknown;
  stableStringify(value: unknown): string;
  VOCABULARY_VERSION: string;
}

/** The fields of latest.json the currency check reads (contract-manifest.types.ts LatestContractPointer is the full shape). */
export interface StoredPointer {
  contractVersion: string;
  contentHash: string;
  vocabularyVersion: string;
  compositionSnapshot: unknown;
  /** M6-P4b0: absent in a pointer written before the block library became an artifact. */
  blockLibrarySha256?: string;
}

/**
 * Is the stored contract still the right one? True when the tenant's composition (as the generator snapshots it)
 * and the vocabulary version both equal what the pointer recorded. Locales are not compared: a tenant's locale set
 * is fixed when it is provisioned (no command changes it afterwards).
 *
 * M6-P4b0: when the image bakes a block-library tarball (`bakedBlockLibrarySha256`), the pointer must also have
 * recorded exactly that tarball, otherwise it is NOT current. That is how a tenant published before the library
 * became an artifact (or under an older library version) is brought along by the next apply or by
 * `contract.regenerate`. With no baked tarball (null) the library takes no part in the answer.
 */
export function isContractCurrent(
  pointer: StoredPointer,
  currentSnapshot: unknown,
  vocabularyVersion: string,
  stableStringify: (v: unknown) => string,
  bakedBlockLibrarySha256: string | null = null,
): boolean {
  if (bakedBlockLibrarySha256 !== null && pointer.blockLibrarySha256 !== bakedBlockLibrarySha256) return false;
  return pointer.vocabularyVersion === vocabularyVersion && stableStringify(pointer.compositionSnapshot) === stableStringify(currentSnapshot);
}

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

export type CodegenBundleImporter = (specifier: string) => Promise<unknown>;
let importBundle: CodegenBundleImporter = nativeImport;

/** Test seam, never set in production: vitest runs modules in a VM context where a Function-constructor
 *  `import()` has no host callback ("A dynamic import callback was not specified"), so a live spec passes
 *  its own `(s) => import(s)`. The bundle loaded is the same real one; only the loading mechanism differs. */
export function setCodegenBundleImporterForTests(importer: CodegenBundleImporter | null): void {
  importBundle = importer ?? nativeImport;
}

/**
 * Where the bundle is. In the image (the Dockerfile compiles only src/) this file is dist/codegen/ and the bundle
 * sits beside it. From a checkout it is <api>/dist/codegen/: reached from the ts source (vitest, src/codegen/) or
 * from a full local tsc build, which also compiles test/ and so nests the output under dist/src/codegen/.
 */
export function resolveBundlePath(env: NodeJS.ProcessEnv = process.env, dir: string = __dirname): string {
  const override = env.WEBDESK_CODEGEN_BUNDLE?.trim();
  const candidates = [
    override,
    join(dir, "generator.mjs"),
    join(dir, "..", "..", "dist", "codegen", "generator.mjs"),
    join(dir, "..", "..", "codegen", "generator.mjs"),
  ].filter(
    (p): p is string => !!p,
  );
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `contract codegen bundle not found (looked in: ${candidates.join(", ")}). It is produced by \`npm run build\` (build:codegen).`,
    );
  }
  return found;
}

@Injectable()
export class CompiledContractCodegenRunner implements ContractCodegenRunner {
  private bundle?: Promise<GeneratorBundle>;
  private storage?: unknown;

  constructor(@Inject(DbService) private readonly db: DbService) {}

  private load(): Promise<GeneratorBundle> {
    // A failed load is not cached: a missing bundle is fixed by a deploy, but a transient read error should retry.
    this.bundle ??= importBundle(pathToFileURL(resolveBundlePath()).href).then(
      (m) => m as GeneratorBundle,
      (err) => {
        this.bundle = undefined;
        throw err;
      },
    );
    return this.bundle;
  }

  async run(tenantSlug: string): Promise<ContractCodegenRunResult> {
    const bundle = await this.load();
    // Built on the first run, not at boot: a deployment that never generates (feature off) never needs STORAGE_* here.
    this.storage ??= bundle.createGeneratorStorageAdapter();
    // Skip a run that would republish an identical contract (see ContractCodegenRunResult). The generator is
    // left exactly as P4r-a proved it; the check sits in front of it and reads only what it already reads.
    const fetched = await bundle.fetchTenantComposition(this.db.pool, tenantSlug);
    if (!fetched) return { outcome: "tenant-not-found" };
    const pointer = await bundle.readLatestPointer(this.storage, tenantSlug);
    const bakedSha256 = bundle.readBakedBlockLibrary()?.sha256 ?? null;
    if (
      pointer &&
      isContractCurrent(pointer, bundle.toContractSnapshot(fetched.composition), bundle.VOCABULARY_VERSION, bundle.stableStringify, bakedSha256)
    ) {
      return { outcome: "unchanged", contractVersion: pointer.contractVersion, contentHash: pointer.contentHash };
    }
    const result = await bundle.generateTenantContract(this.db.pool, this.storage, tenantSlug);
    if (!result) return { outcome: "tenant-not-found" };
    return { outcome: "published", contractVersion: result.built.contractVersion, contentHash: result.built.contentHash };
  }
}
