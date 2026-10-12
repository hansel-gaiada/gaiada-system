// M6-P4d2 - materialise ONE scaffolded fullstack ("node") site on disk, for qa/build-templates.sh.
//
// Runs the real scaffolder (runCodeScaffold) in dry-run with the WSK-18 P3 `acme` fixture (the same one
// runner-dry-run.test.ts uses), then lays the result over a copy of webdesk/templates/fullstack-next-nest,
// exactly as the published template repo plus a scaffold commit would look. No network, no secrets, no hub:
// the snapshot provider and artifact fetcher are the in-memory fakes.
//
//   npx tsx webdesk/templates/qa/scaffold-fullstack-site.mts <out-dir>      (run from ai-agents/, which has tsx)
import { readFileSync, cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodeScaffold } from "../../../ai-agents/src/code-scaffold/scaffold";
import { FakeContractSnapshotProvider } from "../../../ai-agents/src/code-scaffold/contract-snapshot-provider";
import { FakeArtifactFetcher } from "../../../ai-agents/src/code-scaffold/artifact-fetcher";
import { cleanupWorkDir } from "../../../ai-agents/src/code-scaffold/git-writer";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, "../../../ai-agents/src/code-scaffold/__fixtures__/qa-p3-acme");
const TEMPLATE = resolve(HERE, "../fullstack-next-nest");
const fx = (n: string): string => readFileSync(join(FIX, n), "utf8");

const out = process.argv[2];
if (!out) { console.error("usage: scaffold-fullstack-site.mts <out-dir>"); process.exit(2); }
if (existsSync(out)) rmSync(out, { recursive: true, force: true });

const PRD = "# Signed PRD\nA marketing site for Acme with case studies and articles.\n";
const PROTOTYPE = JSON.stringify({
  pages: [
    { slug: "", title: "Home" },
    { slug: "about", title: "About us" },
    { slug: "case-studies", title: "Case Studies", collection: "caseStudy", isListing: true },
    { slug: "case-studies", title: "Case Study", collection: "caseStudy" },
    { slug: "articles", title: "Articles", collection: "article", isListing: true },
  ],
});

const snapshot = {
  meta: {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
    webdeskTenantSlug: "qa-p3-acme",
    contractVersion: "1.0.0",
    vocabularyVersion: "1.1.0",
    contentHash: "sha256:" + "0".repeat(64),
    artifacts: { sdkTs: "f1", sdkPhp: null, openapi: "f2", contractMd: "f3", blockLibrary: null, blockLibraryFile: null },
  },
  openApiDocument: JSON.parse(fx("openapi.v1.json")),
  sdkTsSource: fx("sdk.d.ts.txt"),
  contractMd: fx("CONTENT-CONTRACT.md"),
  blockLibraryTarball: null,
} as never;

const result = await runCodeScaffold(
  {
    runId: "build-templates",
    repoUrl: "https://github.com/example/acme-site",
    siteKind: "node",
    prdArtifact: "prd",
    prototypeArtifact: "proto",
    contractSnapshotId: "bbbbbbbb-0000-4000-8000-000000000002",
    constraints: { blockLibraryVersion: "", maxRevise: 3 },
  },
  {
    tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
    snapshotProvider: FakeContractSnapshotProvider.withOne(snapshot),
    artifactFetcher: new FakeArtifactFetcher(new Map([["prd", PRD], ["proto", PROTOTYPE]])),
    pushTarget: { mode: "dry_run" },
  },
);
if (result.outcome !== "dry_run" || !result.pushedTo) {
  console.error("scaffold did not produce a dry run:", result.outcome, result.content);
  process.exit(1);
}
const workDir = result.pushedTo; // in dry-run the "push target" is the local work dir
mkdirSync(out, { recursive: true });
cpSync(TEMPLATE, out, { recursive: true, filter: (s) => !/[\/](node_modules|\.next|dist)([\/]|$)/.test(s) });
cpSync(workDir, out, { recursive: true, filter: (s) => !/[\/]\.git([\/]|$)/.test(s) });
await cleanupWorkDir(workDir);
console.log(`scaffolded ${result.files?.length ?? "?"} files over the template into ${out}`);
