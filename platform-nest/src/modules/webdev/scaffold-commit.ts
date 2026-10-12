// M6-P4b2 — platform-nest commits the tree `code.scaffold` v2 composed into the provisioned repo, with the ERP App,
// through the Git Data API. Design: docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md (read it first: the
// transport, the measured limits, the authorization decision).
//
// This file is the INTEGRITY CHECKS and the STATE MACHINE, written against ports so it runs without a database
// (scaffold-commit.unit.test.ts) and against a fake GitHub (scaffold-commit-github.test.ts).
// `scaffold-commit.service.ts` binds the ports to Postgres, the ERP App and the ledger, and authorizes.
//
// ═══ WHO WRITES ══════════════════════════════════════════════════════════════════════════════════════
// Only platform-nest, with the `erp` App, through `githubRequest()` (core/github/git-data.ts). ai-agents composed the
// tree and the hub forwarded the bytes; neither holds, sees or forwards a write credential (repo-creation.ts header:
// the prompt-injectable surface must not carry the write arm). Everything below treats the incoming tree as
// UNTRUSTED input and re-derives every fact it relies on.
//
// ═══ THE STATE MACHINE (webdev_provisioned_sites.scaffold_state; migration 202610122130) ═════════════
//
//   NULL ──[claim]──> pending ──[objects]──> commit_created ──[ref]──> committed
//
//   claim    under the site lock, after every integrity check and the pristine read: the manifest digest, snapshot,
//            branch, base (template) commit, counts, goal and actor. Same digest already claimed: resume. A DIFFERENT
//            digest supersedes an unlanded claim (the branch is still the base); never a committed one.
//   objects  OUTSIDE the lock (blobs, trees and commits are content-addressed: a repeat is harmless). Blobs the base
//            tree already holds are not re-uploaded; every uploaded blob's sha is checked against the git blob sha of
//            the verified bytes; one tree on `base_tree`; one commit, parent = base. Recorded under the lock only if
//            the claim still holds this digest.
//   ref      under the lock: head == our commit -> the update landed and the answer was lost: record. head == base ->
//            fast-forward (`force: false`), record. Anything else -> scaffold_repo_not_pristine.
//
// A crash between "commit created" and "ref updated" resumes from the recorded commit sha: no second commit. A crash
// before `commit_created` was recorded leaves a dangling commit object at GitHub that nothing references.
//
// ═══ FIRST FILL ONLY ═════════════════════════════════════════════════════════════════════════════════
// The branch head must be the template's generated commit: no parents (GitHub's template generation makes exactly
// one), no root CONTRACT.lock. A human commit, a force-push, a template that adds commits: all refused. Once
// committed, an identical manifest is a no-op that returns the commit; any other is refused. A re-scaffold over a
// filled repo is a separate, human-approved feature, out of scope.
import { createHash } from "node:crypto";
import {
  createBlob, createCommit, createTree, fastForwardRef, getBranchHead, getCommit, getDefaultBranch, getTreeRecursive,
  gitBlobSha, type GitCaller, type GitTreeEntry, type RepoRef,
} from "../../core/github/git-data";

// ── limits ──────────────────────────────────────────────────────────────────────────────────────────

/** Chosen so the largest conforming request (base64 + ~300 bytes of JSON per entry) stays under platform-nest's
 *  1 MiB Fastify body limit: 600 KiB x 4/3 + 300 x 300 ~ 0.9 MiB. Measured realistic trees: 60-180 KB.
 *  ai-agents mirrors these numbers (code-scaffold/commit-request.ts) to refuse before sending. */
export const SCAFFOLD_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 600 * 1024,
  maxPathBytes: 400,
} as const;

export const CONTRACT_LOCK_PATH = "CONTRACT.lock";
const LOCK_KEYS = ["blockLibraryVersion", "contentHash", "contractVersion", "snapshotId", "vocabularyVersion"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────

/** Every typed reason a scaffold commit can be refused, with the HTTP status the route answers. */
export const SCAFFOLD_REFUSALS = {
  // the tree itself (422)
  scaffold_manifest_invalid: 422,
  scaffold_too_large: 422,
  scaffold_path_refused: 422,
  scaffold_path_conflict: 422,
  scaffold_mode_refused: 422,
  scaffold_hash_mismatch: 422,
  scaffold_lock_missing: 422,
  scaffold_lock_invalid: 422,
  scaffold_lock_snapshot_mismatch: 422,
  scaffold_template_path_refused: 422,
  scaffold_path_conflicts_template: 422,
  // the site or the repo (409)
  scaffold_site_not_complete: 409,
  scaffold_run_mismatch: 409,
  scaffold_repo_unresolved: 409,
  scaffold_repo_not_pristine: 409,
  scaffold_already_committed: 409,
  scaffold_superseded: 409,
  // the far side
  github_blob_sha_mismatch: 502,
  github_write_failed: 502,
  github_app_not_installed: 503,
  github_app_permission_missing: 503,
  github_not_configured: 503,
  github_org_unavailable: 503,
  github_rate_limited: 429,
  not_found: 404,
} as const;
export type ScaffoldRefusalCode = keyof typeof SCAFFOLD_REFUSALS;

export class ScaffoldRefusal extends Error {
  readonly status: number;
  constructor(
    readonly code: ScaffoldRefusalCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ScaffoldRefusal";
    this.status = SCAFFOLD_REFUSALS[code];
  }
}

const refuse = (code: ScaffoldRefusalCode, detail: string): never => {
  throw new ScaffoldRefusal(code, detail);
};

// ── the tree ────────────────────────────────────────────────────────────────────────────────────────

/** One file as the hub tool carries it. */
export interface ScaffoldFileInput {
  path: string;
  base64: string;
  sha256: string;
  bytes: number;
  mode?: string;
}

export interface ContractLock {
  snapshotId: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
  blockLibraryVersion: string;
}

export interface VerifiedFile {
  path: string;
  content: Buffer;
  size: number;
  sha256: string;
  /** Git's blob object id for `content`. */
  gitSha: string;
}

export interface VerifiedTree {
  /** Sorted by path (byte order). */
  files: VerifiedFile[];
  /** sha256 of the canonical manifest: THE identity of a tree. */
  manifestSha256: string;
  totalBytes: number;
  lock: ContractLock;
}

/** Why a path may not be written, or null. Relative POSIX paths only, nothing that escapes the repo or touches git. */
export function pathRefusal(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (Buffer.byteLength(path, "utf8") > SCAFFOLD_LIMITS.maxPathBytes) return `longer than ${SCAFFOLD_LIMITS.maxPathBytes} bytes`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(path)) return "drive-letter path";
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "") return "empty segment";
    if (s === "." || s === "..") return `'${s}' segment`;
    if (s.toLowerCase() === ".git") return "'.git' segment";
  }
  if (path.toLowerCase() === ".gitmodules") return "'.gitmodules' (submodules are not written)";
  return null;
}

/** sha256 over `path\0sha256\0bytes\n`, sorted by path. The same files always give the same digest. */
export function manifestDigest(entries: ReadonlyArray<{ path: string; sha256: string; size: number }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const e of sorted) h.update(`${e.path}\0${e.sha256}\0${e.size}\n`);
  return h.digest("hex");
}

export function parseContractLock(content: Buffer): ContractLock {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    return refuse("scaffold_lock_invalid", "CONTRACT.lock is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("scaffold_lock_invalid", "CONTRACT.lock is not a JSON object");
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== LOCK_KEYS.length || keys.some((k, i) => k !== LOCK_KEYS[i])) {
    return refuse("scaffold_lock_invalid", `CONTRACT.lock must hold exactly ${LOCK_KEYS.join(", ")}`);
  }
  for (const k of LOCK_KEYS) if (typeof o[k] !== "string") return refuse("scaffold_lock_invalid", `CONTRACT.lock.${k} must be a string`);
  for (const k of ["snapshotId", "contractVersion", "vocabularyVersion", "contentHash"]) {
    if (!(o[k] as string)) return refuse("scaffold_lock_invalid", `CONTRACT.lock.${k} is empty`);
  }
  return {
    snapshotId: o.snapshotId as string,
    contractVersion: o.contractVersion as string,
    vocabularyVersion: o.vocabularyVersion as string,
    contentHash: o.contentHash as string,
    blockLibraryVersion: o.blockLibraryVersion as string,
  };
}

/**
 * Checks 1-5 of the design (shape and caps, paths, modes, bytes, the lock's presence and shape). Throws a
 * `ScaffoldRefusal` naming the first problem; returns the verified, decoded tree.
 */
export function verifyScaffoldTree(input: unknown): VerifiedTree {
  if (!Array.isArray(input) || input.length === 0) return refuse("scaffold_manifest_invalid", "files must be a non-empty array");
  if (input.length > SCAFFOLD_LIMITS.maxFiles) {
    return refuse("scaffold_too_large", `${input.length} files; at most ${SCAFFOLD_LIMITS.maxFiles}`);
  }

  // Shape, declared sizes and the cap, BEFORE decoding anything.
  let declaredTotal = 0;
  const entries: ScaffoldFileInput[] = [];
  for (const [i, raw] of input.entries()) {
    if (typeof raw !== "object" || raw === null) return refuse("scaffold_manifest_invalid", `files[${i}] is not an object`);
    const e = raw as Record<string, unknown>;
    if (typeof e.path !== "string") return refuse("scaffold_manifest_invalid", `files[${i}].path must be a string`);
    if (typeof e.base64 !== "string") return refuse("scaffold_manifest_invalid", `files[${i}].base64 must be a string`);
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) {
      return refuse("scaffold_manifest_invalid", `files[${i}].sha256 must be 64 lowercase hex characters`);
    }
    if (typeof e.bytes !== "number" || !Number.isInteger(e.bytes) || e.bytes < 0) {
      return refuse("scaffold_manifest_invalid", `files[${i}].bytes must be a non-negative integer`);
    }
    if (e.mode !== undefined && e.mode !== "100644") {
      return refuse("scaffold_mode_refused", `${e.path}: mode ${String(e.mode)} (only regular files, 100644, are written: no symlinks, submodules or executables)`);
    }
    if (e.bytes > SCAFFOLD_LIMITS.maxFileBytes) {
      return refuse("scaffold_too_large", `${e.path}: ${e.bytes} bytes; at most ${SCAFFOLD_LIMITS.maxFileBytes} per file`);
    }
    declaredTotal += e.bytes;
    entries.push({ path: e.path, base64: e.base64, sha256: e.sha256, bytes: e.bytes });
  }
  if (declaredTotal > SCAFFOLD_LIMITS.maxTotalBytes) {
    return refuse("scaffold_too_large", `${declaredTotal} bytes in total; at most ${SCAFFOLD_LIMITS.maxTotalBytes}`);
  }

  // Paths: each one, then the set (duplicates, case-only duplicates, a file that is also a directory).
  const seen = new Map<string, string>();
  for (const e of entries) {
    const why = pathRefusal(e.path);
    if (why) return refuse("scaffold_path_refused", `${JSON.stringify(e.path)}: ${why}`);
    const folded = e.path.toLowerCase();
    const prior = seen.get(folded);
    if (prior !== undefined) {
      return refuse("scaffold_path_conflict", prior === e.path ? `${e.path} appears twice` : `${prior} and ${e.path} differ only in case`);
    }
    seen.set(folded, e.path);
  }
  for (const folded of seen.keys()) {
    const parts = folded.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (seen.has(dir)) return refuse("scaffold_path_conflict", `${seen.get(dir)} is a file and also a directory of ${seen.get(folded)}`);
    }
  }

  // Bytes: decode, then the declared size and sha256 must match what arrived.
  const files: VerifiedFile[] = [];
  let total = 0;
  for (const e of entries) {
    if (!BASE64_RE.test(e.base64) || e.base64.length % 4 !== 0) return refuse("scaffold_hash_mismatch", `${e.path}: base64 is not canonical`);
    const content = Buffer.from(e.base64, "base64");
    if (content.toString("base64") !== e.base64) return refuse("scaffold_hash_mismatch", `${e.path}: base64 is not canonical`);
    if (content.byteLength !== e.bytes) {
      return refuse("scaffold_hash_mismatch", `${e.path}: ${content.byteLength} bytes arrived, the manifest says ${e.bytes}`);
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== e.sha256) return refuse("scaffold_hash_mismatch", `${e.path}: sha256 ${sha256} does not match the manifest's ${e.sha256}`);
    total += content.byteLength;
    files.push({ path: e.path, content, size: content.byteLength, sha256, gitSha: gitBlobSha(content) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const lockFile = files.find((f) => f.path === CONTRACT_LOCK_PATH);
  if (!lockFile) return refuse("scaffold_lock_missing", "the tree has no CONTRACT.lock at its root");
  const lock = parseContractLock(lockFile.content);

  return { files, manifestSha256: manifestDigest(files), totalBytes: total, lock };
}

/** The pinned snapshot's facts, as the mirror row holds them. */
export interface SnapshotFacts {
  id: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
}

/** Check 5's second half: the lock names exactly the snapshot the site pinned. */
export function checkLockAgainstPin(lock: ContractLock, pinned: SnapshotFacts, requested?: string): void {
  if (requested && requested !== lock.snapshotId) {
    refuse("scaffold_lock_snapshot_mismatch", `the request names snapshot ${requested} but CONTRACT.lock names ${lock.snapshotId}`);
  }
  if (lock.snapshotId !== pinned.id) {
    refuse("scaffold_lock_snapshot_mismatch", `CONTRACT.lock names snapshot ${lock.snapshotId}; the site pinned ${pinned.id}`);
  }
  for (const k of ["contractVersion", "vocabularyVersion", "contentHash"] as const) {
    if (lock[k] !== pinned[k]) {
      refuse("scaffold_lock_snapshot_mismatch", `CONTRACT.lock.${k} is ${JSON.stringify(lock[k])}; the pinned snapshot has ${JSON.stringify(pinned[k])}`);
    }
  }
}

/** The template's tree as GitHub lists it, by path. */
export type BaseTree = ReadonlyMap<string, GitTreeEntry>;

export function baseTreeOf(entries: readonly GitTreeEntry[]): BaseTree {
  return new Map(entries.map((e) => [e.path, e]));
}

/** First-fill check on the base: a root CONTRACT.lock means something was scaffolded already. */
export function pristineRefusal(base: { parents: string[] }, tree: BaseTree, truncated: boolean): string | null {
  if (base.parents.length !== 0) {
    return `the branch head has ${base.parents.length} parent(s): it is not the template's generated commit (first fill only)`;
  }
  if (truncated) return "the template tree is too large to verify";
  if (tree.has(CONTRACT_LOCK_PATH)) return "the branch already carries a CONTRACT.lock (it was scaffolded before)";
  return null;
}

/**
 * Checks 6 and 7: what the template owns. Returns the entries to write: every file except one byte-identical to the
 * base at the same path (a no-op). Throws on a `.github/` path the template does not already hold identically, and
 * on a path that collides with a template directory, symlink, submodule or file-as-parent.
 */
export function entriesOverBase(tree: VerifiedTree, base: BaseTree): VerifiedFile[] {
  const out: VerifiedFile[] = [];
  const folded = new Map<string, string>();
  for (const p of base.keys()) folded.set(p.toLowerCase(), p);
  for (const f of tree.files) {
    const at = base.get(f.path);
    const caseTwin = folded.get(f.path.toLowerCase());
    if (caseTwin !== undefined && caseTwin !== f.path) {
      refuse("scaffold_path_conflicts_template", `${f.path}: the template holds ${caseTwin}, which differs only in case`);
    }
    const identical = at !== undefined && at.type === "blob" && at.mode === "100644" && at.sha === f.gitSha;
    if (f.path.toLowerCase().startsWith(".github/") && !identical) {
      refuse(
        "scaffold_template_path_refused",
        `${f.path}: .github/ belongs to the template (workflows run with the repo's secrets); only a byte-identical file is accepted`,
      );
    }
    if (at && !(at.type === "blob" && (at.mode === "100644" || at.mode === "100755"))) {
      refuse("scaffold_path_conflicts_template", `${f.path}: the template holds a ${at.type === "blob" ? `mode ${at.mode} entry` : at.type} there`);
    }
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const d = base.get(dir);
      if (d && d.type !== "tree") refuse("scaffold_path_conflicts_template", `${f.path}: the template holds ${dir} as a ${d.type === "blob" ? `file (mode ${d.mode})` : d.type}`);
    }
    if (!identical) out.push(f);
  }
  return out;
}

// ── the state machine's ports ───────────────────────────────────────────────────────────────────────

export type ScaffoldState = "pending" | "commit_created" | "committed";

export interface ScaffoldRow {
  id: string;
  tenantId: string;
  provider: string;
  providerRef: string | null;
  status: string;
  repoUrl: string | null;
  pipelineRunId: string | null;
  completionState: string | null;
  contractSnapshotId: string | null;
  scaffoldState: ScaffoldState | null;
  scaffoldManifestSha256: string | null;
  scaffoldSnapshotId: string | null;
  scaffoldBranch: string | null;
  scaffoldBaseSha: string | null;
  scaffoldTreeSha: string | null;
  scaffoldCommitSha: string | null;
  scaffoldFileCount: number | null;
  scaffoldTotalBytes: number | null;
  scaffoldError: string | null;
  scaffoldCommittedAt: string | null;
}

export interface ClaimInput {
  manifestSha256: string;
  snapshotId: string;
  branch: string;
  baseSha: string;
  fileCount: number;
  totalBytes: number;
  goalId: string | null;
  requestedBy: string;
}

/** One transaction holding the site's provisioning lock. */
export interface ScaffoldTx {
  read(): Promise<ScaffoldRow | null>;
  /** -> pending, clearing any earlier tree/commit sha (a fresh claim or a superseded unlanded one). */
  claim(input: ClaimInput): Promise<void>;
  /** pending -> commit_created, only for this digest. */
  markCommitCreated(manifestSha256: string, treeSha: string, commitSha: string): Promise<void>;
  /** commit_created -> committed, only for this digest and commit. */
  markCommitted(manifestSha256: string, commitSha: string): Promise<void>;
  recordError(token: string): Promise<void>;
}

export interface ScaffoldActor {
  userId: string;
  name: string;
  email: string;
}

export interface ScaffoldCommitDeps {
  withLockedSite<T>(fn: (tx: ScaffoldTx) => Promise<T>): Promise<T>;
  readSnapshot(snapshotId: string): Promise<SnapshotFacts | null>;
  /** The repo GH-12 created for this row, or null when it cannot be proven (scaffold_repo_unresolved). */
  resolveRepo(row: ScaffoldRow): Promise<RepoRef | null>;
  /** The ERP App's Git Data caller (production: `erpGitCaller`). */
  git: GitCaller;
  /** Wraps one GitHub write step in the activities ledger (`github.push`, attributed). */
  ledger<T>(
    step: "objects" | "ref",
    target: { repo: RepoRef; branch: string },
    perform: (ctx: { correlationId: string }) => Promise<{ data: T; sha?: string }>,
  ): Promise<{ data: T; correlationId: string }>;
  actor: ScaffoldActor;
  now(): Date;
  /** Maps a far-side error (GitHub, the network) to a typed refusal so it is recorded on the row; null leaves it
   *  unrecorded and rethrown as it is. */
  classifyError?(err: unknown): ScaffoldRefusal | null;
}

export interface ScaffoldCommitRequest {
  siteId: string;
  runId: string;
  goalId?: string | null;
  contractSnapshotId?: string | null;
  files: unknown;
}

export interface ScaffoldCommitResult {
  /** `committed`: this call moved the branch (or finished a landed update). `already_committed`: identical re-submit. */
  outcome: "committed" | "already_committed";
  siteId: string;
  repo: string;
  branch: string;
  baseSha: string;
  treeSha: string;
  commitSha: string;
  snapshotId: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
}

function resultFrom(row: ScaffoldRow, repo: string, outcome: ScaffoldCommitResult["outcome"]): ScaffoldCommitResult {
  return {
    outcome,
    siteId: row.id,
    repo,
    branch: row.scaffoldBranch as string,
    baseSha: row.scaffoldBaseSha as string,
    treeSha: row.scaffoldTreeSha as string,
    commitSha: row.scaffoldCommitSha as string,
    snapshotId: row.scaffoldSnapshotId as string,
    manifestSha256: row.scaffoldManifestSha256 as string,
    fileCount: row.scaffoldFileCount ?? 0,
    totalBytes: row.scaffoldTotalBytes ?? 0,
  };
}

/** The site must be a completed ERP repo control row for THIS run. */
export function sitePreconditions(row: ScaffoldRow, runId: string): void {
  if (row.provider !== "erp_repo" || !row.providerRef) {
    refuse("scaffold_repo_unresolved", "only a repo created by ERP repo control (GH-12) is written");
  }
  if (row.completionState !== "complete" || !row.contractSnapshotId) {
    refuse("scaffold_site_not_complete", `provisioning is not complete (state: ${row.completionState ?? "none"})`);
  }
  if (row.status !== "provisioned" && row.status !== "live") refuse("scaffold_site_not_complete", `the repo step is ${row.status}`);
  if (!row.repoUrl) refuse("scaffold_repo_unresolved", "the provisioned row has no repo_url");
  if (!row.pipelineRunId || row.pipelineRunId !== runId) {
    refuse("scaffold_run_mismatch", `the site belongs to run ${row.pipelineRunId ?? "none"}, the tree to run ${runId}`);
  }
}

/** The commit message: what was written, from what, and the ledger correlation (§4.4 `Gaiada-Activity`). */
export function commitMessage(a: { snapshotId: string; siteId: string; fileCount: number; manifestSha256: string; correlationId: string }): string {
  return (
    `code.scaffold v2: first fill from contract snapshot ${a.snapshotId}\n\n`
    + `${a.fileCount} files composed by the WebDesk scaffolder and committed by the ERP (first fill of the template).\n\n`
    + `Gaiada-Activity: ${a.correlationId}\n`
    + `Gaiada-Provisioned-Site: ${a.siteId}\n`
    + `Gaiada-Contract-Snapshot: ${a.snapshotId}\n`
    + `Gaiada-Scaffold-Manifest: sha256:${a.manifestSha256}\n`
  );
}

const repoName = (r: RepoRef): string => `${r.owner}/${r.name}`;

/**
 * Commit one verified scaffold tree as the first fill of the site's repo. Safe to call again at any point
 * (a crash, a lost answer, a duplicate delivery): it resumes, or returns the recorded commit.
 * Throws `ScaffoldRefusal` for every refusal it decides; GitHub's own errors propagate for the service to classify.
 */
export async function commitScaffoldTree(deps: ScaffoldCommitDeps, req: ScaffoldCommitRequest): Promise<ScaffoldCommitResult> {
  // 1-4: the tree on its own. No row is read and nothing is recorded for a malformed tree.
  const tree = verifyScaffoldTree(req.files);

  const row0 = await deps.withLockedSite((tx) => tx.read());
  if (!row0) return refuse("not_found", "provisioned site not found");

  // Recorded on the row (when it is not yet committed), then rethrown: the last reason is visible on the site.
  const recordAndThrow = async (err: unknown): Promise<never> => {
    const typed = err instanceof ScaffoldRefusal ? err : (deps.classifyError?.(err) ?? null);
    if (typed && typed.code !== "not_found") {
      await deps.withLockedSite(async (tx) => {
        const r = await tx.read();
        if (r && r.scaffoldState !== "committed") await tx.recordError(typed.code);
      });
    }
    throw typed ?? err;
  };

  try {
    sitePreconditions(row0, req.runId);

    // Idempotency fast path: a committed site answers from the row, with no GitHub call.
    const repo = await deps.resolveRepo(row0);
    if (!repo) return refuse("scaffold_repo_unresolved", "the GH-12 repo for this site could not be proven (approval, org or repo_url disagree)");
    if (row0.scaffoldState === "committed") {
      if (row0.scaffoldManifestSha256 === tree.manifestSha256) return resultFrom(row0, repoName(repo), "already_committed");
      return refuse("scaffold_already_committed", `this site's first fill is commit ${row0.scaffoldCommitSha}; a re-scaffold is a separate, human-approved change`);
    }

    // 5: the lock names the pinned snapshot, and agrees with the mirror row.
    const pinned = await deps.readSnapshot(row0.contractSnapshotId as string);
    if (!pinned) return refuse("scaffold_lock_snapshot_mismatch", `the pinned snapshot ${row0.contractSnapshotId} is not readable`);
    checkLockAgainstPin(tree.lock, pinned, req.contractSnapshotId ?? undefined);

    // The base: the recorded one for a claim in flight, else the branch head now.
    const branch = row0.scaffoldBranch ?? (await getDefaultBranch(deps.git, repo));
    const head = await getBranchHead(deps.git, repo, branch);
    if (!head) return refuse("scaffold_repo_not_pristine", `branch ${branch} does not exist`);

    if (row0.scaffoldState === "commit_created" && head === row0.scaffoldCommitSha) {
      // A claim's update landed and the answer was lost. Record it; then answer for THIS tree.
      const landed = await deps.withLockedSite(async (tx) => {
        const r = await tx.read();
        if (r && r.scaffoldState === "commit_created" && r.scaffoldCommitSha === head) {
          await tx.markCommitted(r.scaffoldManifestSha256 as string, head);
        }
        return tx.read();
      });
      if (landed?.scaffoldState === "committed" && landed.scaffoldManifestSha256 === tree.manifestSha256) {
        return resultFrom(landed, repoName(repo), "committed");
      }
      return refuse("scaffold_already_committed", `this site's first fill is commit ${head}; a re-scaffold is a separate, human-approved change`);
    }

    const baseSha = row0.scaffoldState ? (row0.scaffoldBaseSha as string) : head;
    if (head !== baseSha) {
      return refuse("scaffold_repo_not_pristine", `branch ${branch} moved from the template commit ${baseSha} to ${head}`);
    }
    const baseCommit = await getCommit(deps.git, repo, baseSha);
    const listed = await getTreeRecursive(deps.git, repo, baseCommit.treeSha);
    const base = baseTreeOf(listed.entries);
    const notPristine = pristineRefusal(baseCommit, base, listed.truncated);
    if (notPristine) return refuse("scaffold_repo_not_pristine", notPristine);
    // 6-7: what the template owns.
    const toWrite = entriesOverBase(tree, base);

    // CLAIM, under the lock, re-reading everything that matters.
    const claimed = await deps.withLockedSite(async (tx) => {
      const r = await tx.read();
      if (!r) return refuse("not_found", "provisioned site not found");
      if (r.scaffoldState === "committed") {
        if (r.scaffoldManifestSha256 === tree.manifestSha256) return r;
        return refuse("scaffold_already_committed", `this site's first fill is commit ${r.scaffoldCommitSha}`);
      }
      const sameClaim = r.scaffoldState !== null && r.scaffoldManifestSha256 === tree.manifestSha256 && r.scaffoldBaseSha === baseSha;
      if (!sameClaim) {
        if (r.scaffoldState === "commit_created") {
          // Superseding a claim whose commit EXISTS: prove, under the lock (no one can move the branch now), that it did
          // not land. A landed one whose answer was lost is recorded as what it is, the first fill.
          const now = await getBranchHead(deps.git, repo, branch);
          if (now !== null && now === r.scaffoldCommitSha) {
            await tx.markCommitted(r.scaffoldManifestSha256 as string, now);
            return tx.read();
          }
          if (now !== baseSha) return refuse("scaffold_repo_not_pristine", `branch ${branch} moved from the template commit ${baseSha} to ${now ?? "nothing"}`);
        }
        // Fresh, or superseding an UNLANDED claim: the head is the base, so nothing landed.
        await tx.claim({
          manifestSha256: tree.manifestSha256,
          snapshotId: tree.lock.snapshotId,
          branch,
          baseSha,
          fileCount: tree.files.length,
          totalBytes: tree.totalBytes,
          goalId: req.goalId ?? null,
          requestedBy: deps.actor.userId,
        });
      }
      return tx.read();
    });
    if (!claimed) return refuse("not_found", "provisioned site not found");
    if (claimed.scaffoldState === "committed") {
      if (claimed.scaffoldManifestSha256 === tree.manifestSha256) return resultFrom(claimed, repoName(repo), "already_committed");
      return refuse("scaffold_already_committed", `this site's first fill is commit ${claimed.scaffoldCommitSha}; a re-scaffold is a separate, human-approved change`);
    }

    let commitSha = claimed.scaffoldState === "commit_created" ? (claimed.scaffoldCommitSha as string) : null;

    if (!commitSha) {
      // OBJECTS, outside the lock. Content-addressed: repeating any of this is harmless.
      const made = await deps.ledger("objects", { repo, branch }, async ({ correlationId }) => {
        const present = new Set(listed.entries.filter((e) => e.type === "blob").map((e) => e.sha));
        const uploaded = new Set<string>();
        for (const f of toWrite) {
          if (present.has(f.gitSha) || uploaded.has(f.gitSha)) continue;
          const sha = await createBlob(deps.git, repo, f.content);
          if (sha !== f.gitSha) {
            refuse("github_blob_sha_mismatch", `${f.path}: GitHub stored blob ${sha}, the verified bytes hash to ${f.gitSha}`);
          }
          uploaded.add(sha);
        }
        const treeSha = await createTree(deps.git, repo, baseCommit.treeSha, toWrite.map((f) => ({ path: f.path, sha: f.gitSha })));
        const identity = { name: deps.actor.name, email: deps.actor.email, date: deps.now().toISOString() };
        const sha = await createCommit(deps.git, repo, {
          message: commitMessage({
            snapshotId: tree.lock.snapshotId, siteId: claimed.id, fileCount: tree.files.length,
            manifestSha256: tree.manifestSha256, correlationId,
          }),
          tree: treeSha,
          parents: [baseSha],
          author: identity,
          committer: identity,
        });
        return { data: { treeSha, commitSha: sha }, sha };
      });

      const recorded = await deps.withLockedSite(async (tx) => {
        const r = await tx.read();
        if (!r || r.scaffoldManifestSha256 !== tree.manifestSha256 || r.scaffoldBaseSha !== baseSha) {
          return refuse("scaffold_superseded", "a different tree claimed this site while this one was being written");
        }
        if (r.scaffoldState === "pending") await tx.markCommitCreated(tree.manifestSha256, made.data.treeSha, made.data.commitSha);
        return tx.read();
      });
      if (!recorded) return refuse("not_found", "provisioned site not found");
      if (recorded.scaffoldState === "committed") return resultFrom(recorded, repoName(repo), "committed");
      // A racer may have recorded ITS commit for the same tree first: use the recorded one (ours is dangling).
      commitSha = recorded.scaffoldCommitSha as string;
    }

    // REF, under the lock: one writer per site moves the branch.
    const done = await deps.withLockedSite(async (tx) => {
      const r = await tx.read();
      if (!r || r.scaffoldManifestSha256 !== tree.manifestSha256) {
        return refuse("scaffold_superseded", "a different tree claimed this site while this one was being written");
      }
      if (r.scaffoldState === "committed") return r;
      const now = await getBranchHead(deps.git, repo, branch);
      if (now !== commitSha) {
        if (now !== baseSha) {
          // (The refusal rolls this transaction back; `recordAndThrow` records it in its own.)
          return refuse("scaffold_repo_not_pristine", `branch ${branch} moved from the template commit ${baseSha} to ${now ?? "nothing"}`);
        }
        const ff = await deps.ledger("ref", { repo, branch }, async () => ({ data: await fastForwardRef(deps.git, repo, branch, commitSha as string), sha: commitSha as string }));
        if (ff.data.outcome !== "updated") {
          return refuse("scaffold_repo_not_pristine", `branch ${branch} moved while the fill was being written (not a fast forward)`);
        }
      }
      await tx.markCommitted(tree.manifestSha256, commitSha as string);
      return tx.read();
    });
    if (!done) return refuse("not_found", "provisioned site not found");
    return resultFrom(done, repoName(repo), "committed");
  } catch (err) {
    return recordAndThrow(err);
  }
}
