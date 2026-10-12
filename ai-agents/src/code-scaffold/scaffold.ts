// WSK-20 — top-level orchestrator: FROZEN envelope in, ScaffoldResult out. Pure composition + one
// guarded git push; see git-writer.ts's header for the D-6 boundary this respects.
import type { ScaffoldJobEnvelope, ScaffoldResult, VocabularyGap, ContractLock } from "./envelope";
import type { ContractSnapshotProvider } from "./contract-snapshot-provider";
import type { ArtifactFetcher } from "./artifact-fetcher";
import { parseOpenApiCollections } from "./openapi-index";
import { parsePrototypeSpec } from "./prototype-spec";
import { composePages, type GeneratedFile } from "./page-composer";
import { buildContractLock, contractLockFileContent } from "./contract-lock";
import { generateConformanceTest, conformanceTestFilePath } from "./conformance-test";
import { generateQaHarnessWorkflow, qaHarnessWorkflowFilePath } from "./qa-harness-workflow";
import { generateSdkClientModule } from "./sdk-client-template";
import { gitignore, envExample, readme, tsconfig, packageJson } from "./templates/common";
import { astroConfig } from "./templates/astro-site";
import { nodePackageJson, nodeEnvExample, nodeVendoredSdk, blockTypesModule, reactBlocksModule, NODE_WEB_ROOT } from "./templates/node-site";
import { composeNextPages, InvalidPageSlugError } from "./next-page-composer";
import { fileManifest, firstDuplicatePath } from "./file-manifest";
import { wpSiteFiles } from "./templates/wp-site";
import { writeAndPush, vendorFiles, sdkPackageJson, type PushTarget } from "./git-writer";

export interface ScaffoldDeps {
  tenantId: string;
  snapshotProvider: ContractSnapshotProvider;
  artifactFetcher: ArtifactFetcher;
  pushTarget: PushTarget;
}

function rejectedResult(message: string): ScaffoldResult {
  return { outcome: "rejected_site_kind", content: message };
}

export async function runCodeScaffold(envelope: ScaffoldJobEnvelope, deps: ScaffoldDeps): Promise<ScaffoldResult> {
  // WSK-D28 (webdesk-design-v2.md §08): `wp` is no longer refused outright — this is one of the
  // four points that ruling required to move together (the mirror table's `framework` CHECK, the
  // `webdev.provisionSite` tool's enum + stack-hint selector, and this branch). What stays refused,
  // structurally, is anything NOT in the three-kind vocabulary at all.
  if (envelope.siteKind !== "astro" && envelope.siteKind !== "node" && envelope.siteKind !== "wp") {
    return rejectedResult(`unknown siteKind "${envelope.siteKind as string}" — expected "astro", "node" or "wp".`);
  }

  let snapshot;
  try {
    snapshot = await deps.snapshotProvider.getSnapshotArtifacts(deps.tenantId, envelope.contractSnapshotId);
  } catch (err) {
    return { outcome: "snapshot_fetch_failed", content: `failed to read pinned contract snapshot ${envelope.contractSnapshotId}: ${(err as Error).message}`, error: (err as Error).message };
  }

  let prototypeText: string;
  let prdText: string;
  try {
    [prototypeText, prdText] = await Promise.all([
      deps.artifactFetcher.fetchText(deps.tenantId, envelope.prototypeArtifact),
      deps.artifactFetcher.fetchText(deps.tenantId, envelope.prdArtifact),
    ]);
  } catch (err) {
    return { outcome: "artifact_fetch_failed", content: `failed to read prd/prototype artifact: ${(err as Error).message}`, error: (err as Error).message };
  }

  const tenantSlug = snapshot.meta.webdeskTenantSlug;
  // §06: the envelope's blockLibraryVersion is "from the snapshot"; an empty one (a caller that has not read the
  // snapshot, such as the hub tool) takes the snapshot's own pinned library version.
  const blockLibraryVersion = envelope.constraints.blockLibraryVersion || snapshot.meta.artifacts.blockLibrary?.version || "";

  if (envelope.siteKind === "wp") {
    // The PHP theme's ONLY real prerequisite is a generated PHP SDK (WSK-34) pinned on THIS
    // contract snapshot. `sdkPhpSource` is `null`/`undefined` for any snapshot recorded before
    // WSK-34 shipped, or if webdesk/api's codegen genuinely has not produced one yet — either way
    // this refuses LOUDLY, before composing a theme with no SDK to vendor, rather than silently
    // shipping a broken `require_once`. This mirrors the astro/node kinds' own "never invent a
    // page this ticket has no real data source for" rule (page-composer.ts), applied to the one
    // artifact the wp kind cannot do without.
    if (!snapshot.sdkPhpSource) {
      return rejectedResult(
        `siteKind "wp" requires a generated PHP SDK (WSK-34) pinned on contract snapshot ` +
          `${snapshot.meta.id}, and none is recorded (artifacts.sdkPhp is null). Refused before ` +
          `any file was composed — regenerate the contract snapshot once WSK-34's codegen has run ` +
          `for this tenant.`,
      );
    }
    const wpFiles: GeneratedFile[] = [
      ...wpSiteFiles({
        tenantSlug,
        sdkPhpSource: snapshot.sdkPhpSource,
        contractVersion: snapshot.meta.contractVersion,
        vocabularyVersion: snapshot.meta.vocabularyVersion,
      }),
      { path: "docs/PRD.md", content: prdText },
      { path: "docs/PROTOTYPE.md", content: prototypeText },
    ];
    const contractLock = buildContractLock({
      snapshotId: snapshot.meta.id,
      contractVersion: snapshot.meta.contractVersion,
      vocabularyVersion: snapshot.meta.vocabularyVersion,
      contentHash: snapshot.meta.contentHash,
      blockLibraryVersion,
    });
    wpFiles.push({ path: "CONTRACT.lock", content: contractLockFileContent(contractLock) });

    return finish(
      wpFiles,
      contractLock,
      deps.pushTarget,
      `Scaffolded a wp site for tenant "${tenantSlug}" pinned to contract snapshot ` +
        `${snapshot.meta.id} (contract@${snapshot.meta.contractVersion}).`,
      [],
    );
  }

  const index = parseOpenApiCollections(snapshot.openApiDocument);
  const { spec } = parsePrototypeSpec(prototypeText);

  if (envelope.siteKind === "node") {
    // M6-P4b1: the fullstack kind fills the Next + Nest template's `apps/web` only (templates/node-site.ts). It
    // does not consume the Astro block library, so it does not refuse a snapshot that has none.
    let composed;
    try {
      composed = composeNextPages(spec, index);
    } catch (err) {
      if (err instanceof InvalidPageSlugError) return { outcome: "prototype_invalid", content: err.message, error: err.message };
      throw err;
    }
    const nodeFiles: GeneratedFile[] = [
      ...composed.files,
      { path: `${NODE_WEB_ROOT}/src/lib/webdesk-sdk.ts`, content: generateSdkClientModule({ tenantSlug }) },
      blockTypesModule(),
      reactBlocksModule(),
      nodePackageJson(),
      nodeEnvExample(),
      { path: "docs/PRD.md", content: prdText },
      { path: "docs/PROTOTYPE.md", content: prototypeText },
      ...nodeVendoredSdk({ sdkTsSource: snapshot.sdkTsSource, contractVersion: snapshot.meta.contractVersion }),
      {
        path: conformanceTestFilePath(`${NODE_WEB_ROOT}/`),
        content: generateConformanceTest({
          tenantSlug,
          referencedCollections: composed.referencedCollections,
          blockTypesUsed: ["hero", "cta"],
          blockTypesImport: "../lib/block-types",
        }),
      },
    ];
    const nodeLock = buildContractLock({
      snapshotId: snapshot.meta.id,
      contractVersion: snapshot.meta.contractVersion,
      vocabularyVersion: snapshot.meta.vocabularyVersion,
      contentHash: snapshot.meta.contentHash,
      blockLibraryVersion,
    });
    nodeFiles.push({ path: "CONTRACT.lock", content: contractLockFileContent(nodeLock) });
    const dup = firstDuplicatePath(nodeFiles);
    if (dup) {
      const message = `two prototype pages resolve to the same file "${dup}": make the page slugs distinct`;
      return { outcome: "prototype_invalid", content: message, error: message };
    }
    const nodeGaps = composed.gaps.length > 0 ? ` ${composed.gaps.length} vocabulary gap(s) left as TODO + schema-proposal drafts.` : "";
    return finish(
      nodeFiles,
      nodeLock,
      deps.pushTarget,
      `Scaffolded a node (Next + Nest, apps/web) site for tenant "${tenantSlug}" pinned to contract snapshot ${snapshot.meta.id} (contract@${snapshot.meta.contractVersion}).${nodeGaps}`,
      composed.gaps,
    );
  }

  // M6-P4b0: an astro site cannot build without the block library (every page imports it). A snapshot with none
  // is refused here, before anything is composed, never vendored empty. (The node kind renders blocks with its own
  // React renderer and does not need it; wp ships the PHP SDK instead.)
  if (!snapshot.blockLibraryTarball || snapshot.blockLibraryTarball.byteLength === 0) {
    return rejectedResult(
      `siteKind "${envelope.siteKind}" requires the @gaiada/webdesk-blocks library pinned on contract snapshot ` +
        `${snapshot.meta.id}, and none is recorded (artifacts.blockLibraryFile is empty). Refused before any file was ` +
        `composed: refresh the contract once WebDesk's codegen has published the library for this tenant ` +
        `(a snapshot mirrored before M6-P4b0 never has one).`,
    );
  }

  const { files: pageFiles, gaps, referencedCollections } = composePages(spec, index);

  const files: GeneratedFile[] = [
    ...pageFiles,
    { path: "src/lib/webdesk-sdk.ts", content: generateSdkClientModule({ tenantSlug }) },
    gitignore(),
    envExample(),
    readme({ siteKind: envelope.siteKind, tenantSlug, blockLibraryVersion }),
    tsconfig(),
    packageJson({ name: `webdesk-site-${tenantSlug}`, siteKind: "astro", blockLibraryVersion }),
    astroConfig(),
    { path: "docs/PRD.md", content: prdText },
    { path: "docs/PROTOTYPE.md", content: prototypeText },
    ...vendorFiles({
      sdkTsSource: snapshot.sdkTsSource,
      sdkTsPackageJson: sdkPackageJson(snapshot.meta.contractVersion),
      blockLibraryTarball: snapshot.blockLibraryTarball,
    }),
  ];

  const contractLock = buildContractLock({
    snapshotId: snapshot.meta.id,
    contractVersion: snapshot.meta.contractVersion,
    vocabularyVersion: snapshot.meta.vocabularyVersion,
    contentHash: snapshot.meta.contentHash,
    blockLibraryVersion,
  });
  files.push({ path: "CONTRACT.lock", content: contractLockFileContent(contractLock) });

  const blockTypesUsed = ["hero", "cta"]; // static-page placeholder blocks; item pages defer to ItemRenderer's own resolution.
  files.push({
    path: conformanceTestFilePath(),
    content: generateConformanceTest({ tenantSlug, referencedCollections, blockTypesUsed }),
  });
  files.push({ path: qaHarnessWorkflowFilePath(), content: generateQaHarnessWorkflow({}) });

  const gapSummary = gaps.length > 0 ? ` ${gaps.length} vocabulary gap(s) left as TODO + schema-proposal drafts.` : "";
  return finish(
    files,
    contractLock,
    deps.pushTarget,
    `Scaffolded a ${envelope.siteKind} site for tenant "${tenantSlug}" pinned to contract snapshot ${snapshot.meta.id} (contract@${snapshot.meta.contractVersion}).${gapSummary}`,
    gaps,
  );
}

/** Writes the tree (dry run: a local commit and nothing else) and builds the result. The manifest and the lock's
 *  exact text ride in the result so a caller that never sees the work dir (the runner, M6-P4b2's committer) has
 *  the whole description of what was composed. */
async function finish(
  files: GeneratedFile[],
  contractLock: ContractLock,
  pushTarget: PushTarget,
  content: string,
  gaps: VocabularyGap[],
): Promise<ScaffoldResult> {
  const pushResult = await writeAndPush(files, pushTarget);
  return {
    outcome: pushTarget.mode === "dry_run" ? "dry_run" : "pushed",
    content,
    files: files.map((f) => f.path),
    fileManifest: fileManifest(files),
    gaps,
    contractLock,
    contractLockContent: contractLockFileContent(contractLock),
    pushedTo: pushResult.pushedTo,
  };
}

export type { VocabularyGap };
