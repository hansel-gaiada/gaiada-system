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
  // §06: "Per siteKind template: app skeleton... (astro + node; wp is P6 / WSK-35 — do not build
  // it)". This ticket's own hard scope line, enforced structurally: a wp job is refused, never
  // half-built.
  if (envelope.siteKind === "wp") {
    return rejectedResult(
      "siteKind \"wp\" is out of scope for code.scaffold v2 (webdev-design.md §06: WP is P6/WSK-35, headless-WordPress via the PHP SDK — not this ticket). Refused before any file was composed.",
    );
  }
  if (envelope.siteKind !== "astro" && envelope.siteKind !== "node") {
    return rejectedResult(`unknown siteKind "${envelope.siteKind as string}" — expected "astro" or "node" (wp is out of scope).`);
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

  const index = parseOpenApiCollections(snapshot.openApiDocument);
  const { spec } = parsePrototypeSpec(prototypeText);
  const { files: pageFiles, gaps, referencedCollections } = composePages(spec, index);

  const tenantSlug = snapshot.meta.webdeskTenantSlug;
  const blockLibraryVersion = envelope.constraints.blockLibraryVersion;

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
