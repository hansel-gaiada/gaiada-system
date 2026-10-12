// M6-P4b2 — the scaffold commit's integrity checks and state machine, with no database: the site row lives in an
// in-memory transaction (commit on resolve, roll back on throw, like `withTenants`) and GitHub is the in-memory fake
// (core/github/git-data.testkit.ts), so this is also the Git Data API driver test for the whole write.
//
// WHAT THIS SUITE TRIES TO FALSIFY:
//   1. a tree that lies about itself (hash, size, lock, paths, modes, size caps) is refused BEFORE any GitHub call;
//   2. only a first fill lands: a human commit, a scaffolded template, a moved branch are refused;
//   3. an identical re-submit is a no-op (no GitHub call at all); a different tree after the commit is refused;
//   4. a crash or a lost answer between "commit created" and "ref updated" resumes without a second commit;
//   5. `.github/` belongs to the template; the bytes that land are the bytes that were checked.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { GithubApiError } from "../../core/github/errors";
import { FakeGithub } from "../../core/github/git-data.testkit";
import {
  SCAFFOLD_LIMITS, ScaffoldRefusal, commitScaffoldTree, manifestDigest, pathRefusal, verifyScaffoldTree,
  type ClaimInput, type ScaffoldCommitDeps, type ScaffoldRow, type ScaffoldTx, type SnapshotFacts,
} from "./scaffold-commit";

const SNAP: SnapshotFacts = {
  id: "11111111-1111-4111-8111-111111111111",
  contractVersion: "1.0.0",
  vocabularyVersion: "1.1.0",
  contentHash: `sha256:${"a".repeat(64)}`,
};
const RUN = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const ACTOR = { userId: "44444444-4444-4444-8444-444444444444", name: "Automation - Delivery", email: "automation@example.test" };

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const lockText = (over: Partial<Record<string, string>> = {}): string =>
  JSON.stringify(
    { blockLibraryVersion: "0.1.0", contentHash: SNAP.contentHash, contractVersion: SNAP.contractVersion, snapshotId: SNAP.id, vocabularyVersion: SNAP.vocabularyVersion, ...over },
    null,
    2,
  ) + "\n";

type Wire = { path: string; base64: string; sha256: string; bytes: number; mode?: string };
const file = (path: string, content: string | Buffer): Wire => {
  const b = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { path, base64: b.toString("base64"), sha256: sha256(b), bytes: b.byteLength };
};
const tree = (extra: Wire[] = [], lock = lockText()): Wire[] => [
  file("CONTRACT.lock", lock),
  file("src/pages/index.astro", "---\nconst x = 1;\n---\n<h1>Home</h1>\n"),
  file("vendor/webdesk-blocks.tgz", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])),
  ...extra,
];

function freshRow(over: Partial<ScaffoldRow> = {}): ScaffoldRow {
  return {
    id: SITE, tenantId: "t", provider: "erp_repo", providerRef: "approval-1", status: "live",
    repoUrl: "https://github.com/acme-org/acme-site", pipelineRunId: RUN, completionState: "complete", contractSnapshotId: SNAP.id,
    scaffoldState: null, scaffoldManifestSha256: null, scaffoldSnapshotId: null, scaffoldBranch: null, scaffoldBaseSha: null,
    scaffoldTreeSha: null, scaffoldCommitSha: null, scaffoldFileCount: null, scaffoldTotalBytes: null, scaffoldError: null,
    scaffoldCommittedAt: null, ...over,
  };
}

/** The site row behind a lock: each `withLockedSite` works on a copy, kept only when the callback resolves. */
class MemSite {
  row: ScaffoldRow | null;
  failNext: Partial<Record<keyof ScaffoldTx, number>> = {};
  constructor(row: ScaffoldRow | null) {
    this.row = row;
  }
  async withLockedSite<T>(fn: (tx: ScaffoldTx) => Promise<T>): Promise<T> {
    let draft: ScaffoldRow | null = this.row ? { ...this.row } : null;
    const guard = (name: keyof ScaffoldTx) => {
      if ((this.failNext[name] ?? 0) > 0) {
        this.failNext[name]! -= 1;
        throw new Error(`simulated crash in ${name}`);
      }
    };
    const tx: ScaffoldTx = {
      read: async () => (draft ? { ...draft } : null),
      claim: async (c: ClaimInput) => {
        guard("claim");
        if (!draft) throw new Error("no row");
        draft = {
          ...draft, scaffoldState: "pending", scaffoldManifestSha256: c.manifestSha256, scaffoldSnapshotId: c.snapshotId,
          scaffoldBranch: c.branch, scaffoldBaseSha: c.baseSha, scaffoldTreeSha: null, scaffoldCommitSha: null,
          scaffoldFileCount: c.fileCount, scaffoldTotalBytes: c.totalBytes, scaffoldError: null,
        };
      },
      markCommitCreated: async (digest, treeSha, commitSha) => {
        guard("markCommitCreated");
        if (!draft || draft.scaffoldState !== "pending" || draft.scaffoldManifestSha256 !== digest) throw new Error("guarded update matched 0 rows");
        draft = { ...draft, scaffoldState: "commit_created", scaffoldTreeSha: treeSha, scaffoldCommitSha: commitSha, scaffoldError: null };
      },
      markCommitted: async (digest, commitSha) => {
        guard("markCommitted");
        if (!draft || draft.scaffoldState !== "commit_created" || draft.scaffoldManifestSha256 !== digest || draft.scaffoldCommitSha !== commitSha) {
          throw new Error("guarded update matched 0 rows");
        }
        draft = { ...draft, scaffoldState: "committed", scaffoldCommittedAt: "2026-10-12T00:00:00Z", scaffoldError: null };
      },
      recordError: async (token) => {
        if (draft) draft = { ...draft, scaffoldError: token };
      },
    };
    const out = await fn(tx);
    this.row = draft;
    return out;
  }
}

interface Harness {
  gh: FakeGithub;
  site: MemSite;
  deps: ScaffoldCommitDeps;
  ledger: Array<{ step: string; outcome: string }>;
  base: string;
}

function harness(opts: { template?: Record<string, string | { content?: string; mode?: string; type?: "blob" | "commit"; sha?: string }>; row?: Partial<ScaffoldRow>; snapshot?: SnapshotFacts | null; repo?: boolean } = {}): Harness {
  const gh = new FakeGithub("acme-org", "acme-site");
  const base = gh.seedTemplate(opts.template ?? { "README.md": "# template\n", ".github/workflows/site.yml": "name: site\n", "src/layouts/Base.astro": "<slot />\n" });
  const site = new MemSite(freshRow(opts.row));
  const ledger: Harness["ledger"] = [];
  let n = 0;
  const deps: ScaffoldCommitDeps = {
    withLockedSite: (fn) => site.withLockedSite(fn),
    readSnapshot: async (id) => (opts.snapshot === null ? null : id === (opts.snapshot ?? SNAP).id ? (opts.snapshot ?? SNAP) : null),
    resolveRepo: async () => (opts.repo === false ? null : { owner: "acme-org", name: "acme-site" }),
    git: gh.caller(),
    ledger: async (step, _target, perform) => {
      const correlationId = `corr-${++n}`;
      try {
        const r = await perform({ correlationId });
        ledger.push({ step, outcome: "succeeded" });
        return { data: r.data, correlationId };
      } catch (err) {
        ledger.push({ step, outcome: "failed" });
        throw err;
      }
    },
    actor: ACTOR,
    now: () => new Date("2026-10-12T08:00:00.000Z"),
    classifyError: (err) => (err instanceof GithubApiError ? new ScaffoldRefusal("github_write_failed", err.message) : null),
  };
  return { gh, site, deps, ledger, base };
}

const req = (files: unknown, over: Record<string, unknown> = {}) => ({ siteId: SITE, runId: RUN, goalId: null, files, ...over });

async function refusal(p: Promise<unknown>): Promise<ScaffoldRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ScaffoldRefusal) return err;
    throw err;
  }
  throw new Error("expected a ScaffoldRefusal, the call succeeded");
}

describe("integrity checks (no GitHub call for a tree that lies)", () => {
  it("path rules: refuse escapes, absolute paths, .git, control characters, backslashes; accept ordinary paths", () => {
    for (const bad of ["", "../x", "a/../b", "./a", "/etc/passwd", "C:/x", "a\\b", ".git/config", "src/.GIT/hooks/x", "a//b", "a/", ".gitmodules", "a\u0000b", "x".repeat(401)]) {
      expect(pathRefusal(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const ok of ["README.md", ".gitignore", ".env.example", "src/pages/[slug].astro", "vendor/webdesk-sdk/index.d.ts", "docs/PRD.md"]) {
      expect(pathRefusal(ok), ok).toBeNull();
    }
  });

  it.each([
    ["a sha256 that does not match the bytes", () => { const t = tree(); t[1] = { ...t[1], sha256: "0".repeat(64) }; return t; }, "scaffold_hash_mismatch"],
    ["a size that does not match the bytes", () => { const t = tree(); t[1] = { ...t[1], bytes: t[1].bytes + 1 }; return t; }, "scaffold_hash_mismatch"],
    ["non-canonical base64", () => { const t = tree(); t[1] = { ...t[1], base64: `${t[1].base64}\n` }; return t; }, "scaffold_hash_mismatch"],
    ["a path that escapes the repo", () => tree([file("../outside.txt", "x")]), "scaffold_path_refused"],
    ["an absolute path", () => tree([file("/etc/cron.d/x", "x")]), "scaffold_path_refused"],
    ["a .git path", () => tree([file(".git/hooks/post-checkout", "x")]), "scaffold_path_refused"],
    ["a symlink mode", () => tree([{ ...file("link", "../../etc/passwd"), mode: "120000" }]), "scaffold_mode_refused"],
    ["an executable mode", () => tree([{ ...file("run.sh", "#!/bin/sh"), mode: "100755" }]), "scaffold_mode_refused"],
    ["a duplicate path", () => tree([file("README.md", "a"), file("README.md", "a")]), "scaffold_path_conflict"],
    ["a case-only duplicate", () => tree([file("README.md", "a"), file("readme.md", "b")]), "scaffold_path_conflict"],
    ["a file that is also a directory", () => tree([file("docs", "x"), file("docs/PRD.md", "y")]), "scaffold_path_conflict"],
    ["no CONTRACT.lock", () => tree().slice(1), "scaffold_lock_missing"],
    ["a lock that is not JSON", () => tree([], "not json"), "scaffold_lock_invalid"],
    ["a lock with an extra key", () => tree([], JSON.stringify({ ...JSON.parse(lockText()), extra: "x" })), "scaffold_lock_invalid"],
    ["an empty files array", () => [], "scaffold_manifest_invalid"],
    ["a bad sha256 shape", () => { const t = tree(); t[1] = { ...t[1], sha256: "ABC" }; return t; }, "scaffold_manifest_invalid"],
  ])("refuses %s", (_label, build, code) => {
    let err: unknown;
    try {
      verifyScaffoldTree(build());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScaffoldRefusal);
    expect((err as ScaffoldRefusal).code).toBe(code);
  });

  it("size caps: per file, in total and in count, checked on the declared sizes before decoding", () => {
    const big = Buffer.alloc(SCAFFOLD_LIMITS.maxFileBytes + 1, 0x61);
    expect(() => verifyScaffoldTree(tree([file("big.bin", big)]))).toThrow(/scaffold_too_large/);
    const half = Buffer.alloc(SCAFFOLD_LIMITS.maxFileBytes - 10, 0x62);
    expect(() => verifyScaffoldTree(tree([file("a.bin", half), file("b.bin", half)]))).toThrow(/scaffold_too_large.*in total/);
    const many = Array.from({ length: SCAFFOLD_LIMITS.maxFiles }, (_, i) => file(`f/${i}.txt`, String(i)));
    expect(() => verifyScaffoldTree(tree(many))).toThrow(/scaffold_too_large.*files/);
    // A lie about the size cannot slip a large payload past the cap: the decoded length must equal the declared one.
    const lie = { ...file("big.bin", big), bytes: 10 };
    expect(() => verifyScaffoldTree(tree([lie]))).toThrow(/scaffold_hash_mismatch/);
  });

  it("the manifest digest is the tree's identity: order-independent, content-sensitive", () => {
    const a = verifyScaffoldTree(tree());
    const b = verifyScaffoldTree([...tree()].reverse());
    expect(a.manifestSha256).toBe(b.manifestSha256);
    expect(a.manifestSha256).toBe(manifestDigest(a.files));
    const c = verifyScaffoldTree(tree([file("extra.txt", "x")]));
    expect(c.manifestSha256).not.toBe(a.manifestSha256);
  });
});

describe("commitScaffoldTree — the first fill (fake GitHub)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("HAPPY PATH: blobs, one tree on the template, one commit on the template commit, a fast-forward; recorded committed", async () => {
    const r = await commitScaffoldTree(h.deps, req(tree()));
    expect(r).toMatchObject({ outcome: "committed", siteId: SITE, repo: "acme-org/acme-site", branch: "main", baseSha: h.base, snapshotId: SNAP.id, fileCount: 3 });
    expect(h.gh.headOf()).toBe(r.commitSha);
    const commit = h.gh.commits.get(r.commitSha)!;
    expect(commit.parents).toEqual([h.base]);
    expect(commit.author).toEqual({ name: ACTOR.name, email: ACTOR.email, date: "2026-10-12T08:00:00.000Z" });
    expect(commit.message).toContain("Gaiada-Activity: corr-1");
    expect(commit.message).toContain(`Gaiada-Contract-Snapshot: ${SNAP.id}`);
    expect(commit.message).toContain(`Gaiada-Provisioned-Site: ${SITE}`);
    // The template's files stay; the scaffold's files land with the exact bytes that were verified.
    const files = h.gh.filesAt(r.commitSha);
    expect(files.get("README.md")).toBe("# template\n");
    expect(files.get(".github/workflows/site.yml")).toBe("name: site\n");
    expect(files.get("CONTRACT.lock")).toBe(lockText());
    expect(h.site.row).toMatchObject({ scaffoldState: "committed", scaffoldCommitSha: r.commitSha, scaffoldTreeSha: r.treeSha, scaffoldBaseSha: h.base, scaffoldError: null });
    expect(h.gh.count("PATCH", "/git/refs/heads/main")).toBe(1);
    expect(h.ledger).toEqual([{ step: "objects", outcome: "succeeded" }, { step: "ref", outcome: "succeeded" }]);
  });

  it("IDEMPOTENT: an identical re-submit returns the recorded commit and makes NO GitHub call", async () => {
    const first = await commitScaffoldTree(h.deps, req(tree()));
    const before = h.gh.calls.length;
    const again = await commitScaffoldTree(h.deps, req([...tree()].reverse()));
    expect(again).toMatchObject({ outcome: "already_committed", commitSha: first.commitSha, treeSha: first.treeSha });
    expect(h.gh.calls.length).toBe(before);
  });

  it("a DIFFERENT tree after the first fill is refused (re-scaffold is out of scope); the branch is untouched", async () => {
    const first = await commitScaffoldTree(h.deps, req(tree()));
    const e = await refusal(commitScaffoldTree(h.deps, req(tree([file("new.txt", "x")]))));
    expect(e.code).toBe("scaffold_already_committed");
    expect(h.gh.headOf()).toBe(first.commitSha);
    expect(h.site.row?.scaffoldError).toBeNull(); // a committed site does not take a later attempt's error
  });

  it("NOT PRISTINE: a human commit on the template is refused before anything is written", async () => {
    const human = h.gh.pushHumanCommit({ "notes.md": "mine" });
    const e = await refusal(commitScaffoldTree(h.deps, req(tree())));
    expect(e.code).toBe("scaffold_repo_not_pristine");
    expect(e.detail).toMatch(/1 parent/);
    expect(h.gh.headOf()).toBe(human);
    expect(h.gh.count("POST", "/git/")).toBe(0);
    expect(h.site.row).toMatchObject({ scaffoldState: null, scaffoldError: "scaffold_repo_not_pristine" });
  });

  it("NOT PRISTINE: a template that already carries a CONTRACT.lock is refused", async () => {
    const g = harness({ template: { "CONTRACT.lock": "{}", "README.md": "x" } });
    expect((await refusal(commitScaffoldTree(g.deps, req(tree())))).code).toBe("scaffold_repo_not_pristine");
  });

  it("the lock must name the PINNED snapshot, and agree with its versions and content hash", async () => {
    const other = await refusal(commitScaffoldTree(h.deps, req(tree([], lockText({ snapshotId: "99999999-9999-4999-8999-999999999999" })))));
    expect(other.code).toBe("scaffold_lock_snapshot_mismatch");
    const drift = await refusal(commitScaffoldTree(h.deps, req(tree([], lockText({ contentHash: `sha256:${"b".repeat(64)}` })))));
    expect(drift.code).toBe("scaffold_lock_snapshot_mismatch");
    const asked = await refusal(commitScaffoldTree(h.deps, req(tree(), { contractSnapshotId: "99999999-9999-4999-8999-999999999999" })));
    expect(asked.code).toBe("scaffold_lock_snapshot_mismatch");
    expect(h.gh.count("POST", "/git/")).toBe(0);
  });

  it("a hash mismatch is refused before the site is even read, and nothing is recorded", async () => {
    const t = tree();
    t[1] = { ...t[1], sha256: "f".repeat(64) };
    expect((await refusal(commitScaffoldTree(h.deps, req(t)))).code).toBe("scaffold_hash_mismatch");
    expect(h.gh.calls).toHaveLength(0);
    expect(h.site.row?.scaffoldError).toBeNull();
  });

  it("site scope: not complete, another run, not an ERP repo control row, an unprovable repo", async () => {
    expect((await refusal(commitScaffoldTree(harness({ row: { completionState: "tenant_ready" } }).deps, req(tree())))).code).toBe("scaffold_site_not_complete");
    expect((await refusal(commitScaffoldTree(h.deps, req(tree(), { runId: "55555555-5555-4555-8555-555555555555" })))).code).toBe("scaffold_run_mismatch");
    expect((await refusal(commitScaffoldTree(harness({ row: { provider: "provision" } }).deps, req(tree())))).code).toBe("scaffold_repo_unresolved");
    expect((await refusal(commitScaffoldTree(harness({ repo: false }).deps, req(tree())))).code).toBe("scaffold_repo_unresolved");
    const gone = harness();
    gone.site.row = null;
    expect((await refusal(commitScaffoldTree(gone.deps, req(tree())))).code).toBe("not_found");
  });

  it(".github/ belongs to the template: a new workflow is refused, a byte-identical one is a no-op", async () => {
    const e = await refusal(commitScaffoldTree(h.deps, req(tree([file(".github/workflows/qa-harness.yml", "name: qa\n")]))));
    expect(e.code).toBe("scaffold_template_path_refused");
    const changed = await refusal(commitScaffoldTree(h.deps, req(tree([file(".github/workflows/site.yml", "name: evil\n")]))));
    expect(changed.code).toBe("scaffold_template_path_refused");
    expect(h.gh.count("POST", "/git/")).toBe(0);
    const same = await commitScaffoldTree(h.deps, req(tree([file(".github/workflows/site.yml", "name: site\n")])));
    expect(same.outcome).toBe("committed");
    const treeBody = h.gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/trees"))!.body as { tree: Array<{ path: string }> };
    expect(treeBody.tree.map((t) => t.path)).not.toContain(".github/workflows/site.yml");
  });

  it("refuses paths that collide with what the template holds (a directory, a symlink, a file used as a directory, a case twin)", async () => {
    const g = harness({ template: { "README.md": "x", "lib/a.txt": "1", "link": { content: "target", mode: "120000" }, "assets": "a file", "Docs/x.md": "d" } });
    expect((await refusal(commitScaffoldTree(g.deps, req(tree([file("lib", "x")]))))).code).toBe("scaffold_path_conflicts_template");
    expect((await refusal(commitScaffoldTree(g.deps, req(tree([file("link", "x")]))))).code).toBe("scaffold_path_conflicts_template");
    expect((await refusal(commitScaffoldTree(g.deps, req(tree([file("assets/logo.svg", "<svg/>")]))))).code).toBe("scaffold_path_conflicts_template");
    expect((await refusal(commitScaffoldTree(g.deps, req(tree([file("docs/x.md", "y")]))))).code).toBe("scaffold_path_conflicts_template");
  });

  it("the bytes that land are the bytes that were checked: a blob sha GitHub disagrees with is refused, nothing moves", async () => {
    h.gh.corruptNextBlobSha = true;
    const e = await refusal(commitScaffoldTree(h.deps, req(tree())));
    expect(e.code).toBe("github_blob_sha_mismatch");
    expect(h.gh.headOf()).toBe(h.base);
    expect(h.site.row).toMatchObject({ scaffoldState: "pending", scaffoldError: "github_blob_sha_mismatch" });
    expect(h.ledger).toEqual([{ step: "objects", outcome: "failed" }]);
    // and the next attempt finishes it
    expect((await commitScaffoldTree(h.deps, req(tree()))).outcome).toBe("committed");
  });

  it("blobs the template already holds are not re-uploaded", async () => {
    await commitScaffoldTree(h.deps, req(tree([file("src/layouts/Base.astro", "<slot />\n"), file("README2.md", "# template\n")])));
    // README2.md has the same bytes as the template's README.md: same blob, no upload. Base.astro is identical: no entry.
    expect(h.gh.count("POST", "/git/blobs")).toBe(3);
  });
});

describe("commitScaffoldTree — crash and resume", () => {
  it("CRASH between 'commit created' and 'ref updated' (the PATCH never reached GitHub): the retry reuses the commit", async () => {
    const h = harness();
    let dropped = false;
    h.gh.beforeRequest = (method, path) => {
      if (method === "PATCH" && path.includes("/git/refs/heads/") && !dropped) {
        dropped = true;
        throw new GithubApiError(`${method} ${path}`, 0, "network_error_or_timeout");
      }
    };
    const e = await refusal(commitScaffoldTree(h.deps, req(tree())));
    expect(e.code).toBe("github_write_failed");
    expect(h.site.row).toMatchObject({ scaffoldState: "commit_created", scaffoldError: "github_write_failed" });
    const recorded = h.site.row!.scaffoldCommitSha!;
    expect(h.gh.headOf()).toBe(h.base);

    const r = await commitScaffoldTree(h.deps, req(tree()));
    expect(r).toMatchObject({ outcome: "committed", commitSha: recorded });
    expect(h.gh.headOf()).toBe(recorded);
    expect(h.gh.count("POST", "/git/commits")).toBe(1); // no second commit
    expect(h.site.row).toMatchObject({ scaffoldState: "committed", scaffoldError: null });
  });

  it("LOST ANSWER: GitHub moved the branch but the answer was lost; the retry records it without a second PATCH", async () => {
    const h = harness();
    let lost = false;
    h.gh.afterRequest = (method, path) => {
      if (method === "PATCH" && !lost) {
        lost = true;
        throw new GithubApiError(`${method} ${path}`, 0, "network_error_or_timeout");
      }
    };
    await refusal(commitScaffoldTree(h.deps, req(tree())));
    const recorded = h.site.row!.scaffoldCommitSha!;
    expect(h.site.row?.scaffoldState).toBe("commit_created");
    expect(h.gh.headOf()).toBe(recorded); // it DID land

    const r = await commitScaffoldTree(h.deps, req(tree()));
    expect(r).toMatchObject({ outcome: "committed", commitSha: recorded });
    expect(h.gh.count("PATCH", "/git/refs/heads/")).toBe(1);
    expect(h.gh.count("POST", "/git/commits")).toBe(1);
  });

  it("CRASH after GitHub made the commit but before it was recorded: the retry makes its own; the first stays dangling", async () => {
    const h = harness();
    h.site.failNext.markCommitCreated = 1;
    await expect(commitScaffoldTree(h.deps, req(tree()))).rejects.toThrow(/simulated crash/);
    expect(h.site.row?.scaffoldState).toBe("pending");
    expect(h.gh.headOf()).toBe(h.base);

    const r = await commitScaffoldTree(h.deps, req(tree()));
    expect(r.outcome).toBe("committed");
    expect(h.gh.commits.get(r.commitSha)!.parents).toEqual([h.base]);
    expect(h.gh.headOf()).toBe(r.commitSha);
  });

  it("a human push between the claim and the ref update is never overwritten (fast-forward only)", async () => {
    const h = harness();
    h.gh.beforeRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/git/commits") && h.gh.count("POST", "/git/commits") === 1) {
        h.gh.pushHumanCommit({ "hotfix.md": "human" });
      }
    };
    const e = await refusal(commitScaffoldTree(h.deps, req(tree())));
    expect(e.code).toBe("scaffold_repo_not_pristine");
    expect(h.gh.filesAt(h.gh.headOf()!).get("hotfix.md")).toBe("human");
    expect(h.gh.count("PATCH", "/git/refs/heads/")).toBe(0);
    expect(h.site.row).toMatchObject({ scaffoldState: "commit_created", scaffoldError: "scaffold_repo_not_pristine" });
  });

  it("a LANDED claim whose answer was lost is never superseded: a different tree finds it, records it, and is refused", async () => {
    const h = harness();
    let lost = false;
    h.gh.afterRequest = (method) => {
      if (method === "PATCH" && !lost) {
        lost = true;
        throw new GithubApiError("PATCH", 0, "network_error_or_timeout");
      }
    };
    await refusal(commitScaffoldTree(h.deps, req(tree())));
    const landed = h.site.row!.scaffoldCommitSha!;
    expect(h.gh.headOf()).toBe(landed);
    expect(h.site.row?.scaffoldState).toBe("commit_created");
    // A different tree read the row as commit_created; the head is no longer the base, so it is refused as not pristine
    // or already committed, and the landed fill is recorded either way.
    const e = await refusal(commitScaffoldTree(h.deps, req(tree([file("b.txt", "B")]))));
    expect(["scaffold_already_committed", "scaffold_repo_not_pristine"]).toContain(e.code);
    expect(h.gh.headOf()).toBe(landed);
    expect(h.site.row?.scaffoldState).toBe("committed");
  });

  it("RACE: a claim lands while a different tree is about to supersede it; the check under the lock catches it", async () => {
    const h = harness();
    let dropped = false;
    h.gh.beforeRequest = (method) => {
      if (method === "PATCH" && !dropped) {
        dropped = true;
        throw new GithubApiError("PATCH", 0, "network_error_or_timeout");
      }
    };
    await refusal(commitScaffoldTree(h.deps, req(tree())));
    const first = h.site.row!.scaffoldCommitSha!;
    expect(h.gh.headOf()).toBe(h.base);
    // The second tree reads the head as the base; then, before it takes the lock, the first writer's update lands.
    h.gh.afterRequest = (method, path) => {
      if (method === "GET" && path.includes("/git/trees/")) h.gh.refs.set("main", first);
    };
    const e = await refusal(commitScaffoldTree(h.deps, req(tree([file("b.txt", "B")]))));
    expect(e.code).toBe("scaffold_already_committed");
    expect(h.site.row).toMatchObject({ scaffoldState: "committed", scaffoldCommitSha: first });
    expect(h.gh.count("POST", "/git/commits")).toBe(1); // the second tree never made a commit
  });

  it("an UNLANDED claim is superseded by a different tree; the stale writer then gives way", async () => {
    const h = harness();
    // tree A gets as far as commit_created, then its PATCH fails
    let once = false;
    h.gh.beforeRequest = (method) => {
      if (method === "PATCH" && !once) {
        once = true;
        throw new GithubApiError("PATCH", 0, "network_error_or_timeout");
      }
    };
    await refusal(commitScaffoldTree(h.deps, req(tree())));
    expect(h.site.row?.scaffoldState).toBe("commit_created");
    // tree B (different) arrives: the branch is still the template, so B supersedes A and lands
    const b = await commitScaffoldTree(h.deps, req(tree([file("b.txt", "B")])));
    expect(b.outcome).toBe("committed");
    expect(h.gh.filesAt(b.commitSha).get("b.txt")).toBe("B");
    // A re-submitted now is a different tree after the first fill: refused
    expect((await refusal(commitScaffoldTree(h.deps, req(tree())))).code).toBe("scaffold_already_committed");
  });
});
