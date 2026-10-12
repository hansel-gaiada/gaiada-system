// M6-P4b2 — hands a composed tree to platform-nest, which commits it as the FIRST FILL of the provisioned repo with the
// ERP GitHub App. Design: docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md.
//
// ── NO CREDENTIAL HERE, NO PUSH HERE ──────────────────────────────────────────────────────────────
// This file makes ONE hub tool call, `webdev.provisionedSites.commitScaffold`, with the run's OBO envelope, exactly like
// every other call this goal makes (hub-client.ts). It carries the files by value (base64, size, sha256) and nothing
// else: no remote, no token, no branch. platform-nest decides everything (which repo, whether it is still the
// template's commit, whether CONTRACT.lock names the pinned snapshot) and re-hashes every byte. `git-writer.ts`'s push
// branch stays unreachable from the runner (runner-job.ts hard-codes `{ mode: "dry_run" }`).
//
// ── THE LIMITS ARE platform-nest's ────────────────────────────────────────────────────────────────
// `SCAFFOLD_COMMIT_LIMITS` mirrors `SCAFFOLD_LIMITS` in platform-nest/src/modules/webdev/scaffold-commit.ts (read, not
// imported: separate projects). They exist so a request always fits platform-nest's 1 MiB body limit; checking them
// here only saves a doomed call, platform-nest enforces them regardless.
import { createHash } from "node:crypto";
import type { Envelope } from "../agent";
import type { ToolCaller } from "./hub-client";
import { parseToolJson } from "./hub-client";
import type { GeneratedFile } from "./page-composer";

export const COMMIT_SCAFFOLD_TOOL = "webdev.provisionedSites.commitScaffold";

export const SCAFFOLD_COMMIT_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 600 * 1024,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The goal's opt-in: `commit: { provisionedSiteId }`, a sibling of the frozen §06 envelope (never inside it). */
export interface ScaffoldCommitTarget {
  provisionedSiteId: string;
}

/** Reads the goal's `commit` key. Absent: null (a pure dry run). Present but malformed: throws, so the job refuses
 *  as `invalid_job` instead of silently skipping a commit the caller asked for. */
export function parseCommitTarget(goal: string): ScaffoldCommitTarget | null {
  let raw: unknown;
  try {
    raw = JSON.parse(goal);
  } catch {
    return null; // parseScaffoldGoal reports the unparseable goal
  }
  const c = (raw as Record<string, unknown> | null)?.commit;
  if (c === undefined || c === null) return null;
  const id = typeof c === "object" ? (c as Record<string, unknown>).provisionedSiteId : undefined;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error('the goal\'s "commit" must be { "provisionedSiteId": "<uuid>" }');
  }
  return { provisionedSiteId: id.toLowerCase() };
}

export interface CommitFile {
  path: string;
  base64: string;
  sha256: string;
  bytes: number;
}

/** Every file by value, sorted by path. The sha256 is over the exact bytes (fileManifest's own rule). */
export function commitFiles(files: GeneratedFile[]): CommitFile[] {
  return files
    .map((f) => {
      const bytes = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
      return { path: f.path, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Why platform-nest would refuse this tree on size alone, or null. */
export function sizeRefusal(files: CommitFile[]): string | null {
  if (files.length > SCAFFOLD_COMMIT_LIMITS.maxFiles) return `scaffold_too_large: ${files.length} files; at most ${SCAFFOLD_COMMIT_LIMITS.maxFiles}`;
  let total = 0;
  for (const f of files) {
    if (f.bytes > SCAFFOLD_COMMIT_LIMITS.maxFileBytes) return `scaffold_too_large: ${f.path} is ${f.bytes} bytes; at most ${SCAFFOLD_COMMIT_LIMITS.maxFileBytes} per file`;
    total += f.bytes;
  }
  if (total > SCAFFOLD_COMMIT_LIMITS.maxTotalBytes) return `scaffold_too_large: ${total} bytes in total; at most ${SCAFFOLD_COMMIT_LIMITS.maxTotalBytes}`;
  return null;
}

/** What platform-nest answers for a commit (scaffold-commit.ts `ScaffoldCommitResult`). */
export interface ScaffoldCommitReply {
  outcome: "committed" | "already_committed";
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

/** The commit's part of the job result: the reply, or the refusal token platform-nest (or the size check) gave. */
export type ScaffoldCommitRecord =
  | ({ provisionedSiteId: string } & ScaffoldCommitReply)
  | { provisionedSiteId: string; outcome: "refused"; error: string };

/** The hub's error text is `tool failed: <platform's error token>`; keep the token, drop the wrapper. */
function refusalToken(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return m.replace(/^tool failed:\s*/, "").slice(0, 300);
}

/**
 * Offers the tree to platform-nest. Never throws: a refusal (not pristine, a lock mismatch, the site not complete) is
 * a result, recorded in the goal's blackboard, so the goal reports it instead of disappearing into a log.
 */
export async function commitThroughPlatform(args: {
  callTool: ToolCaller;
  envelope: Envelope;
  tenantId: string;
  target: ScaffoldCommitTarget;
  runId: string;
  goalId?: string;
  contractSnapshotId: string;
  files: GeneratedFile[];
}): Promise<ScaffoldCommitRecord> {
  const siteId = args.target.provisionedSiteId;
  if (!UUID_RE.test(args.runId)) {
    return { provisionedSiteId: siteId, outcome: "refused", error: "scaffold_run_mismatch: a commit needs the pipeline run id (runId) the site was provisioned for" };
  }
  const files = commitFiles(args.files);
  const tooBig = sizeRefusal(files);
  if (tooBig) return { provisionedSiteId: siteId, outcome: "refused", error: tooBig };
  try {
    const raw = await args.callTool(
      COMMIT_SCAFFOLD_TOOL,
      {
        tenantId: args.tenantId,
        siteId,
        runId: args.runId,
        ...(args.goalId ? { goalId: args.goalId } : {}),
        contractSnapshotId: args.contractSnapshotId,
        files,
      },
      args.envelope,
    );
    const reply = parseToolJson<ScaffoldCommitReply>(raw);
    if (reply?.outcome !== "committed" && reply?.outcome !== "already_committed") {
      return { provisionedSiteId: siteId, outcome: "refused", error: "commit_reply_unreadable" };
    }
    return { provisionedSiteId: siteId, ...reply };
  } catch (err) {
    return { provisionedSiteId: siteId, outcome: "refused", error: refusalToken(err) };
  }
}
