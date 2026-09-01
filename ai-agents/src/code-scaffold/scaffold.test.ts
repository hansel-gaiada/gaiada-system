import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { runCodeScaffold } from "./scaffold";
import { FakeContractSnapshotProvider, SnapshotNotFoundError, type ContractSnapshotArtifacts } from "./contract-snapshot-provider";
import { FakeArtifactFetcher, type ArtifactFetcher } from "./artifact-fetcher";
import type { ScaffoldJobEnvelope } from "./envelope";

function baseEnvelope(overrides: Partial<ScaffoldJobEnvelope> = {}): ScaffoldJobEnvelope {
  return {
    runId: "run-1",
    repoUrl: "https://github.com/gaiada/example-site",
    siteKind: "astro",
    prdArtifact: "artifact:prd:1",
    prototypeArtifact: "artifact:prototype:1",
    contractSnapshotId: "snap-1",
    constraints: { blockLibraryVersion: "1.3.2", maxRevise: 3 },
    ...overrides,
  };
}

function fixtureSnapshot(overrides: Partial<ContractSnapshotArtifacts["meta"]> = {}): ContractSnapshotArtifacts {
  return {
    meta: {
      id: "snap-1",
      tenantId: "t1",
      webdeskTenantSlug: "acme",
      contractVersion: "1.4.0",
      vocabularyVersion: "1.2.0",
      contentHash: "sha256:abc",
      artifacts: {
        sdkTs: "file-sdk",
        sdkPhp: null,
        openapi: "file-openapi",
        contractMd: "file-md",
        blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
      },
      ...overrides,
    },
    openApiDocument: { paths: { "/v1/t/acme/case-study": {}, "/v1/t/acme/case-study/{slug}": {} } },
    sdkTsTarball: Buffer.from("fake-sdk-tarball"),
    contractMd: "# Content contract\n",
    blockLibraryTarball: Buffer.from("fake-blocks-tarball"),
  };
}

const structuredPrototype = JSON.stringify({
  pages: [
    { slug: "", title: "Home" },
    { slug: "case-studies", title: "Case Studies", collection: "case-study" },
  ],
});

function fixtureFetcher(prototype = structuredPrototype): ArtifactFetcher {
  return new FakeArtifactFetcher(
    new Map([
      ["artifact:prd:1", "# Signed PRD\nBuild a marketing site.\n"],
      ["artifact:prototype:1", prototype],
    ]),
  );
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const d of cleanupDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("runCodeScaffold — siteKind gating (WSK-D28 / webdesk-design-v2.md §08: astro/node/wp, wp wired)", () => {
  it("refuses a genuinely unknown siteKind before fetching anything", async () => {
    let called = false;
    const snapshotProvider = { getSnapshotArtifacts: async () => { called = true; return fixtureSnapshot(); } };
    const result = await runCodeScaffold(baseEnvelope({ siteKind: "php-legacy" as never }), {
      tenantId: "t1",
      snapshotProvider,
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    expect(result.outcome).toBe("rejected_site_kind");
    expect(result.content).toMatch(/unknown siteKind/);
    expect(called).toBe(false);
  });

  it("accepts astro and node", async () => {
    for (const siteKind of ["astro", "node"] as const) {
      const result = await runCodeScaffold(baseEnvelope({ siteKind }), {
        tenantId: "t1",
        snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
        artifactFetcher: fixtureFetcher(),
        pushTarget: { mode: "dry_run" },
      });
      expect(result.outcome).toBe("dry_run");
      if (result.pushedTo) cleanupDirs.push(result.pushedTo);
    }
  });

  it("wp refuses loudly (never fabricates a theme) when the snapshot has no PHP SDK pinned", async () => {
    const result = await runCodeScaffold(baseEnvelope({ siteKind: "wp" }), {
      tenantId: "t1",
      // fixtureSnapshot()'s default has `artifacts.sdkPhp: null` and no `sdkPhpSource` — the
      // pre-WSK-34 / not-yet-generated case this branch must catch rather than compose around.
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    expect(result.outcome).toBe("rejected_site_kind");
    expect(result.content).toMatch(/PHP SDK|WSK-34/);
  });

  it("wp composes the vendored PHP SDK theme and pushes when the snapshot has one pinned", async () => {
    const result = await runCodeScaffold(baseEnvelope({ siteKind: "wp" }), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne({
        ...fixtureSnapshot(),
        sdkPhpSource: "<?php // fake generated sdk.php\n",
      }),
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    if (result.pushedTo) cleanupDirs.push(result.pushedTo);

    expect(result.outcome).toBe("dry_run");
    expect(result.files).toContain("style.css");
    expect(result.files).toContain("vendor/gaiada-sdk/sdk.php");
    expect(result.files).toContain("functions.php");
    expect(result.files).toContain("page.php");
    expect(result.files).toContain("CONTRACT.lock");
    // wp is not built from page-composer (a different, PHP-templated content model) — it must
    // never carry astro/node-only artifacts.
    expect(result.files).not.toContain("src/lib/webdesk-sdk.ts");
    expect(result.contractLock).toEqual({
      snapshotId: "snap-1",
      contractVersion: "1.4.0",
      vocabularyVersion: "1.2.0",
      contentHash: "sha256:abc",
      blockLibraryVersion: "1.3.2",
    });
  });
});

describe("runCodeScaffold — success path", () => {
  it("produces CONTRACT.lock pinned to the exact snapshot, the conformance test, and the QA-harness stub", async () => {
    const result = await runCodeScaffold(baseEnvelope(), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    if (result.pushedTo) cleanupDirs.push(result.pushedTo);

    expect(result.outcome).toBe("dry_run");
    expect(result.contractLock).toEqual({
      snapshotId: "snap-1",
      contractVersion: "1.4.0",
      vocabularyVersion: "1.2.0",
      contentHash: "sha256:abc",
      blockLibraryVersion: "1.3.2",
    });
    expect(result.files).toContain("CONTRACT.lock");
    expect(result.files).toContain("src/__generated__/contract-conformance.test.ts");
    expect(result.files).toContain(".github/workflows/qa-harness.yml");
    expect(result.files).toContain("src/lib/webdesk-sdk.ts");
    expect(result.gaps).toEqual([]);
  });

  it("is a genuine pin: two runs against the SAME snapshot id produce the same CONTRACT.lock content", async () => {
    const run = () =>
      runCodeScaffold(baseEnvelope(), {
        tenantId: "t1",
        snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
        artifactFetcher: fixtureFetcher(),
        pushTarget: { mode: "dry_run" },
      });
    const [a, b] = await Promise.all([run(), run()]);
    if (a.pushedTo) cleanupDirs.push(a.pushedTo);
    if (b.pushedTo) cleanupDirs.push(b.pushedTo);
    expect(a.contractLock).toEqual(b.contractLock);
  });
});

describe("runCodeScaffold — vocabulary gap flow", () => {
  it("a prototype page bound to a collection the snapshot does not have becomes a reported gap, not a build failure", async () => {
    const prototypeWithGap = JSON.stringify({
      pages: [{ slug: "team", title: "Team", collection: "team-member" }],
    });
    const result = await runCodeScaffold(baseEnvelope(), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(prototypeWithGap),
      pushTarget: { mode: "dry_run" },
    });
    if (result.pushedTo) cleanupDirs.push(result.pushedTo);

    expect(result.outcome).toBe("dry_run"); // a gap degrades gracefully — it is not a hard failure
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps![0].reference).toBe("team-member");
    expect(result.content).toMatch(/1 vocabulary gap/);
    expect(result.files!.some((f) => f.startsWith("webdesk-schema-proposals/"))).toBe(true);
  });
});

describe("runCodeScaffold — upstream failure honesty", () => {
  it("an unknown snapshot id fails the job with snapshot_fetch_failed, not a silently-empty repo", async () => {
    const result = await runCodeScaffold(baseEnvelope({ contractSnapshotId: "does-not-exist" }), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    expect(result.outcome).toBe("snapshot_fetch_failed");
    expect(result.error).toBeDefined();
  });

  it("SnapshotNotFoundError is the concrete error type a Fake miss throws", async () => {
    const provider = FakeContractSnapshotProvider.withOne(fixtureSnapshot());
    await expect(provider.getSnapshotArtifacts("t1", "nope")).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("a missing prd/prototype artifact fails with artifact_fetch_failed", async () => {
    const result = await runCodeScaffold(baseEnvelope({ prototypeArtifact: "artifact:missing" }), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(),
      pushTarget: { mode: "dry_run" },
    });
    expect(result.outcome).toBe("artifact_fetch_failed");
  });
});

describe("runCodeScaffold — markdown-shaped prototype (today's actual design.prototype v1 output)", () => {
  it("degrades to static pages, never inventing an SDK call, and still produces a valid CONTRACT.lock", async () => {
    const md = "# Acme — Design Brief\n\n## Home\nHero.\n\n## About\nCopy.\n";
    const result = await runCodeScaffold(baseEnvelope(), {
      tenantId: "t1",
      snapshotProvider: FakeContractSnapshotProvider.withOne(fixtureSnapshot()),
      artifactFetcher: fixtureFetcher(md),
      pushTarget: { mode: "dry_run" },
    });
    if (result.pushedTo) cleanupDirs.push(result.pushedTo);
    expect(result.outcome).toBe("dry_run");
    expect(result.gaps).toEqual([]); // no gaps — nothing was invented to create one
    expect(result.contractLock!.snapshotId).toBe("snap-1");
  });
});
