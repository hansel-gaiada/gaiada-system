// WSK-20 — top-level orchestrator: FROZEN envelope in, ScaffoldResult out. Pure composition + one
// guarded git push; see git-writer.ts's header for the D-6 boundary this respects.
import type { ScaffoldJobEnvelope, ScaffoldResult, VocabularyGap } from "./envelope";
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
import { astroConfig as astroConfigAstro } from "./templates/astro-site";
import { astroConfig as astroConfigNode } from "./templates/node-site";
import { wpSiteFiles } from "./templates/wp-site";
import { writeAndPush, vendorFiles, type PushTarget } from "./git-writer";

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
  const blockLibraryVersion = envelope.constraints.blockLibraryVersion;

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

    const pushResult = await writeAndPush(wpFiles, deps.pushTarget);
    return {
      outcome: deps.pushTarget.mode === "dry_run" ? "dry_run" : "pushed",
      content:
        `Scaffolded a wp site for tenant "${tenantSlug}" pinned to contract snapshot ` +
        `${snapshot.meta.id} (contract@${snapshot.meta.contractVersion}).`,
      files: wpFiles.map((f) => f.path),
      gaps: [],
      contractLock,
      pushedTo: pushResult.pushedTo,
    };
  }

  const index = parseOpenApiCollections(snapshot.openApiDocument);
  const { spec } = parsePrototypeSpec(prototypeText);
  const { files: pageFiles, gaps, referencedCollections } = composePages(spec, index);

  const files: GeneratedFile[] = [
    ...pageFiles,
    { path: "src/lib/webdesk-sdk.ts", content: generateSdkClientModule({ tenantSlug }) },
    gitignore(),
    envExample(),
    readme({ siteKind: envelope.siteKind, tenantSlug, blockLibraryVersion }),
    tsconfig(),
    packageJson({ name: `webdesk-site-${tenantSlug}`, siteKind: envelope.siteKind, blockLibraryVersion }),
    envelope.siteKind === "astro" ? astroConfigAstro() : astroConfigNode(),
    { path: "docs/PRD.md", content: prdText },
    { path: "docs/PROTOTYPE.md", content: prototypeText },
    ...vendorFiles({
      sdkTsTarball: snapshot.sdkTsTarball,
      sdkTsPackageJson: JSON.stringify({ name: "@gaiada/webdesk-sdk", version: snapshot.meta.contractVersion }, null, 2) + "\n",
      blockLibraryTarballPlaceholder: snapshot.blockLibraryTarball,
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

  const pushResult = await writeAndPush(files, deps.pushTarget);

  const gapSummary = gaps.length > 0 ? ` ${gaps.length} vocabulary gap(s) left as TODO + schema-proposal drafts.` : "";
  return {
    outcome: deps.pushTarget.mode === "dry_run" ? "dry_run" : "pushed",
    content: `Scaffolded a ${envelope.siteKind} site for tenant "${tenantSlug}" pinned to contract snapshot ${snapshot.meta.id} (contract@${snapshot.meta.contractVersion}).${gapSummary}`,
    files: files.map((f) => f.path),
    gaps,
    contractLock,
    pushedTo: pushResult.pushedTo,
  };
}

export type { VocabularyGap };
