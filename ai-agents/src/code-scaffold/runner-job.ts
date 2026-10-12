// M6-P4b1 - `code.scaffold` v2 as an agent-runner job. The runner (runner/service.ts) dispatches a goal whose
// `agent` is CODE_SCAFFOLD_AGENT here instead of to a model loop: there is no LLM in this path (WSK-D6: the
// scaffolder composes files deterministically from untrusted PRD/prototype text, it never lets a model decide
// what gets built).
//
// ── DRY RUN ONLY ────────────────────────────────────────────────────────────────────────────────────
// The target is hard-coded to `{ mode: "dry_run" }`. Nothing in the goal text can select a push: the goal is
// parsed into the frozen envelope and every other key is ignored, so a `mode` or a `remoteUrl` in it changes
// nothing. The agents' GitHub App and the hub are read-only by design; only platform-nest holds the write
// credential (D29).
//
// ── THE COMMIT IS platform-nest's (M6-P4b2) ────────────────────────────────────────────────────────
// A goal may carry `commit: { provisionedSiteId }` beside the envelope (the delivery workflow sends it once the
// site's provisioning is complete). Then, after a successful dry run, this job OFFERS the composed tree to
// platform-nest through the hub tool `webdev.provisionedSites.commitScaffold` (commit-request.ts), with the run's
// OBO envelope, carrying the files by value. platform-nest re-hashes every byte, checks CONTRACT.lock against the
// site's pinned snapshot, and writes the first fill with the ERP App, or refuses. This job still never pushes and
// never holds a credential; `mode` stays "dry_run" because it describes the composer, and the commit's outcome is
// its own field. Without `commit` the job is exactly the M6-P4b1 dry run.
//
// ── AT MOST ONE GOAL PER SITE AND SNAPSHOT (M6-P4e3) ───────────────────────────────────────────────
// The delivery workflow calls `code.scaffold` (which files this goal and returns at once) and only afterwards creates
// the single-shot `claude_code` stage, so two near-simultaneous deliveries (a gate decision plus the
// `ev/webdev.site.contract_pinned` resume, or an at-least-once redelivery after a first attempt died between the two
// calls) could each queue a goal. `scaffoldDedupeKey` below derives the goal's idempotency key from its own text, and the
// runner's `POST /goals` files a scaffold goal through `GoalStore.insertGoalOnce`: while a goal with that key is queued,
// running or finished ok, a second call gets THAT goal's id and status back (`deduped: true`) and queues nothing; a
// failed, cancelled or interrupted goal frees the key, so a retry is a new goal. The check is atomic (a partial unique
// index in Postgres), not a read-then-write. The key is derived here, inside the runner, so no caller can skip it.
//
// ── THE RESULT IS DATA, NOT A PATH ─────────────────────────────────────────────────────────────────
// The tree is composed in a temp dir (so the dry-run writer exercises the real write + local commit), and the
// dir is removed before returning. What leaves this module is `ScaffoldJobResult`: the file list with sizes and
// sha256, the `CONTRACT.lock` text, the gaps and the pin. The runner stores it as the goal's blackboard entry.
//
// ── CONTRACT (goal text) ───────────────────────────────────────────────────────────────────────────
// The goal text is the JSON of ScaffoldGoalPayload (the frozen §06 envelope, minus a target). The company is the
// goal's own `tenantId`, authoritative and tenant-pinned by the runner, never read from the text.
import { createHash } from "node:crypto";
import type { Envelope } from "../agent";
import type { ToolCaller } from "./hub-client";
import type { ScaffoldFileEntry, ScaffoldJobEnvelope, ScaffoldOutcome, ContractLock, SiteKind, VocabularyGap } from "./envelope";
import { runCodeScaffold } from "./scaffold";
import { HubContractSnapshotProvider } from "./contract-snapshot-provider";
import { HubArtifactFetcher } from "./artifact-fetcher";
import { cleanupWorkDir } from "./git-writer";
import { commitThroughPlatform, parseCommitTarget, type ScaffoldCommitRecord, type ScaffoldCommitTarget } from "./commit-request";

/** The `agent` name a goal carries to be dispatched to this job. */
export const CODE_SCAFFOLD_AGENT = "code-scaffold-v2";

/** The goal text of a scaffold job holds the PRD/prototype artifact refs, which are stored text today, so the
 *  runner's usual 4000-character goal cap is raised for this agent only. */
export const SCAFFOLD_GOAL_MAX_CHARS = 100_000;

/** The goal text: the frozen envelope, plus (M6-P4b2) an optional `commit` beside it, never inside it. */
export type ScaffoldGoalPayload = ScaffoldJobEnvelope & { commit?: ScaffoldCommitTarget };

/** "invalid_job": the goal text was not a valid envelope. "job_failed": the composer or the dry-run writer threw
 *  (for example the runner image has no `git`). Both are results, so the runner records them as a failed goal.
 *  M6-P4b2: "committed" (a commit was asked for and platform-nest committed the tree, or already had) and
 *  "commit_failed" (it refused, or the size check did; `commit.error` names why). */
export type ScaffoldJobOutcome = ScaffoldOutcome | "invalid_job" | "job_failed" | "committed" | "commit_failed";

export interface ScaffoldJobResult {
  outcome: ScaffoldJobOutcome;
  /** Always "dry_run": this job never pushes. */
  mode: "dry_run";
  siteKind?: SiteKind;
  contractSnapshotId?: string;
  /** Human-readable summary. */
  content: string;
  error?: string;
  /** Present when outcome is "dry_run". Sorted by path; every entry has its size and sha256. */
  files?: ScaffoldFileEntry[];
  /** The exact text of the composed `CONTRACT.lock` (repo root). */
  contractLockContent?: string;
  contractLock?: ContractLock;
  gaps?: VocabularyGap[];
  /** M6-P4b2 - present when the goal asked for a commit: platform-nest's reply, or the refusal token. */
  commit?: ScaffoldCommitRecord;
}

/** The idempotency key of a scaffold goal, or null when the goal text is not a valid scaffold envelope (such a goal
 *  is not deduplicated: it files as before and the job fails it as `invalid_job`).
 *  With `commit.provisionedSiteId`: one goal per provisioned site and pinned snapshot, whatever else differs (the
 *  repo takes a first fill once, so a second goal for the same pair is wasted work).
 *  Without it (a dry run, nothing to commit): the envelope's identifying fields, so only an identical request dedupes.
 *  The company is NOT in the key: the store scopes it by the goal's own tenant. */
export function scaffoldDedupeKey(goal: string): string | null {
  let job: ScaffoldJobEnvelope;
  let target: ScaffoldCommitTarget | null;
  try {
    job = parseScaffoldGoal(goal);
    target = parseCommitTarget(goal);
  } catch {
    return null;
  }
  const snapshot = job.contractSnapshotId.trim();
  if (target) return `scaffold:site=${target.provisionedSiteId}:snapshot=${snapshot}`;
  const fields = [job.runId, job.repoUrl, job.siteKind, job.prdArtifact, job.prototypeArtifact, snapshot, job.constraints.blockLibraryVersion, job.constraints.maxRevise];
  return `scaffold:dryrun=${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

const SITE_KINDS: readonly string[] = ["astro", "node", "wp"];

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Parses the goal text into the frozen envelope. Throws a plain Error naming the first problem. */
export function parseScaffoldGoal(goal: string): ScaffoldJobEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(goal);
  } catch {
    throw new Error("the goal text of a code-scaffold-v2 job must be the JSON scaffold envelope");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the scaffold envelope must be a JSON object");
  const o = raw as Record<string, unknown>;
  for (const key of ["runId", "repoUrl", "prdArtifact", "prototypeArtifact", "contractSnapshotId"] as const) {
    if (!nonEmptyString(o[key])) throw new Error(`the scaffold envelope needs a non-empty "${key}"`);
  }
  if (typeof o.siteKind !== "string" || !SITE_KINDS.includes(o.siteKind)) {
    throw new Error(`the scaffold envelope's "siteKind" must be one of ${SITE_KINDS.join(", ")}`);
  }
  const c = typeof o.constraints === "object" && o.constraints !== null ? (o.constraints as Record<string, unknown>) : {};
  const maxRevise = typeof c.maxRevise === "number" && Number.isInteger(c.maxRevise) && c.maxRevise >= 0 ? c.maxRevise : 3;
  return {
    runId: o.runId as string,
    repoUrl: o.repoUrl as string,
    siteKind: o.siteKind as SiteKind,
    prdArtifact: o.prdArtifact as string,
    prototypeArtifact: o.prototypeArtifact as string,
    contractSnapshotId: o.contractSnapshotId as string,
    // "from the snapshot": empty means the scaffolder takes the snapshot's own pinned library version.
    constraints: { blockLibraryVersion: typeof c.blockLibraryVersion === "string" ? c.blockLibraryVersion : "", maxRevise },
  };
}

/** Runs one scaffold job against the hub (the run's OBO envelope), in dry-run mode. Never throws for a job
 *  problem: a bad goal, a missing snapshot, a refused kind all come back as a result with a non-ok outcome. */
export async function runScaffoldJob(args: {
  goal: string;
  tenantId: string;
  envelope: Envelope;
  callTool: ToolCaller;
  /** The runner goal's id, recorded by platform-nest with a commit for correlation. */
  goalId?: string;
}): Promise<ScaffoldJobResult> {
  let job: ScaffoldJobEnvelope;
  let commitTarget: ScaffoldCommitTarget | null;
  try {
    job = parseScaffoldGoal(args.goal);
    commitTarget = parseCommitTarget(args.goal);
  } catch (err) {
    const message = (err as Error).message;
    return { outcome: "invalid_job", mode: "dry_run", content: message, error: message };
  }

  let result;
  try {
    result = await runCodeScaffold(job, {
      tenantId: args.tenantId,
      snapshotProvider: new HubContractSnapshotProvider(args.callTool, args.envelope),
      artifactFetcher: new HubArtifactFetcher(args.callTool, args.envelope),
      pushTarget: { mode: "dry_run" },
    });
  } catch (err) {
    const message = (err as Error).message;
    return {
      outcome: "job_failed",
      mode: "dry_run",
      siteKind: job.siteKind,
      contractSnapshotId: job.contractSnapshotId,
      content: `code.scaffold v2 failed: ${message}`,
      error: message,
    };
  }

  // The dry-run writer leaves its work dir for a caller that wants to look; this caller does not.
  if (result.pushedTo) await cleanupWorkDir(result.pushedTo).catch(() => undefined);

  // M6-P4b2: offer the composed tree to platform-nest, only after a successful dry run, only when asked.
  let commit: ScaffoldCommitRecord | undefined;
  if (commitTarget && result.outcome === "dry_run" && result.generatedFiles) {
    commit = await commitThroughPlatform({
      callTool: args.callTool,
      envelope: args.envelope,
      tenantId: args.tenantId,
      target: commitTarget,
      runId: job.runId,
      goalId: args.goalId,
      contractSnapshotId: job.contractSnapshotId,
      files: result.generatedFiles,
    });
  }
  const outcome: ScaffoldJobOutcome = commit ? (commit.outcome === "refused" ? "commit_failed" : "committed") : result.outcome;
  const commitNote = !commit
    ? ""
    : commit.outcome === "refused"
      ? ` The commit was refused: ${commit.error}.`
      : ` platform-nest ${commit.outcome === "committed" ? "committed" : "had already committed"} it to ${commit.repo}@${commit.branch} as ${commit.commitSha}.`;

  return {
    outcome,
    mode: "dry_run",
    siteKind: job.siteKind,
    contractSnapshotId: job.contractSnapshotId,
    content: result.content + commitNote,
    ...(result.error ? { error: result.error } : commit?.outcome === "refused" ? { error: commit.error } : {}),
    ...(result.fileManifest ? { files: result.fileManifest } : {}),
    ...(result.contractLockContent ? { contractLockContent: result.contractLockContent } : {}),
    ...(result.contractLock ? { contractLock: result.contractLock } : {}),
    ...(result.gaps ? { gaps: result.gaps } : {}),
    ...(commit ? { commit } : {}),
  };
}
